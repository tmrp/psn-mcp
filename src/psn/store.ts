/**
 * PlayStation Store catalog access (deals, search, product details).
 *
 * The store's GraphQL API only accepts whitelisted persisted queries, so
 * instead of chasing query hashes this module reads the same data from the
 * server-rendered store pages: every page embeds its Apollo state (products,
 * prices, discounts) and micro-frontend payloads (star ratings) in a
 * __NEXT_DATA__ JSON blob. No authentication is required - this is the
 * public web store.
 */

const STORE_BASE = "https://store.playstation.com";

/** The store's evergreen "All deals" category. */
export const ALL_DEALS_CATEGORY_ID = "3f772501-f6f8-49b7-abac-874a88ca4897";

const PAGE_SIZE = 24; // fixed by the store's category grid

export class PsnStoreError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "PsnStoreError";
  }
}

export interface StorePrice {
  basePrice?: string;
  discountedPrice?: string;
  discountText?: string;
  isFree?: boolean;
  isTiedToSubscription?: boolean;
}

export interface StoreItem {
  productId: string;
  name: string;
  type?: string;
  platforms?: string[];
  price?: StorePrice;
  imageUrl?: string;
}

export interface StarRating {
  averageRating: number;
  totalRatingsCount: number;
  ratingsDistribution?: Array<{ rating: number; percentage: string }>;
}

export interface CategoryGridPage {
  categoryId: string;
  categoryName?: string;
  page: number;
  pageSize: number;
  totalCount?: number;
  items: StoreItem[];
}

export interface StoreProduct extends StoreItem {
  starRating?: StarRating;
  conceptId?: string;
  url: string;
}

interface ApolloEntity {
  __typename?: string;
  [key: string]: unknown;
}

type ApolloState = Record<string, ApolloEntity>;

export class PsnStore {
  constructor(private readonly locale: string = "en-us") {}

  private async fetchNextData(path: string): Promise<{
    apollo: ApolloState;
    pageProps: Record<string, unknown>;
    title?: string;
  }> {
    const url = `${STORE_BASE}/${this.locale}${path}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new PsnStoreError(
        `PlayStation Store request to ${url} failed with HTTP ${res.status}`,
        res.status,
      );
    }
    const html = await res.text();
    const match = html.match(
      /<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s,
    );
    if (!match) {
      throw new PsnStoreError(
        `Could not find embedded page data at ${url}; the store layout may have changed.`,
      );
    }
    const data = JSON.parse(match[1]) as {
      props?: {
        apolloState?: ApolloState;
        pageProps?: Record<string, unknown>;
      };
    };
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
    return {
      apollo: data.props?.apolloState ?? {},
      pageProps: data.props?.pageProps ?? {},
      title,
    };
  }

  private toStoreItem(entity: ApolloEntity): StoreItem {
    const price = entity.price as StorePrice | undefined;
    const media = entity.media as
      Array<{ type: string; url: string; role: string }> | undefined;
    const image =
      media?.find((m) => m.type === "IMAGE" && m.role === "MASTER") ??
      media?.find((m) => m.type === "IMAGE");
    return {
      productId: String(entity.id ?? ""),
      name: String(entity.name ?? ""),
      type: (entity.localizedStoreDisplayClassification ??
        entity.storeDisplayClassification) as string | undefined,
      platforms: entity.platforms as string[] | undefined,
      price: price && {
        basePrice: price.basePrice,
        discountedPrice: price.discountedPrice,
        discountText: price.discountText,
        isFree: price.isFree,
        isTiedToSubscription: price.isTiedToSubscription,
      },
      imageUrl: image?.url,
    };
  }

  /** One page (24 items) of a store category grid, e.g. the "All deals" category. */
  async getCategoryGrid(
    categoryId: string,
    page = 1,
  ): Promise<CategoryGridPage> {
    const { apollo, title } = await this.fetchNextData(
      `/category/${encodeURIComponent(categoryId)}/${page}`,
    );

    const grid = Object.entries(apollo).find(([key]) =>
      key.startsWith("CategoryGrid:"),
    )?.[1];
    if (!grid) {
      throw new PsnStoreError(
        `No category grid found for category ${categoryId} (page ${page}). ` +
          "The category id may be invalid or the page out of range.",
      );
    }

    // The grid lists products as Apollo refs; resolve them in grid order.
    const refs =
      (grid.products as Array<{ __ref?: string } | ApolloEntity>) ?? [];
    const items = refs
      .map((ref) =>
        "__ref" in ref && typeof ref.__ref === "string"
          ? apollo[ref.__ref]
          : ref,
      )
      .filter((p): p is ApolloEntity => Boolean(p && (p as ApolloEntity).id))
      .map((p) => this.toStoreItem(p));

    const pageInfo = grid.pageInfo as { totalCount?: number } | undefined;
    return {
      categoryId,
      categoryName: title?.split("|")[0]?.trim(),
      page,
      pageSize: PAGE_SIZE,
      totalCount: pageInfo?.totalCount,
      items,
    };
  }

  /** Product details including price and the community star rating. */
  async getProduct(productId: string): Promise<StoreProduct> {
    const { apollo, pageProps } = await this.fetchNextData(
      `/product/${encodeURIComponent(productId)}`,
    );

    const entity =
      apollo[`Product:${productId}`] ??
      Object.entries(apollo).find(
        ([key, value]) =>
          key.startsWith("Product:") && value.__typename === "Product",
      )?.[1];
    if (!entity) {
      throw new PsnStoreError(
        `Product ${productId} not found on the PlayStation Store.`,
      );
    }

    return {
      ...this.toStoreItem(entity),
      starRating: this.extractStarRating(pageProps, productId),
      url: `${STORE_BASE}/${this.locale}/product/${productId}`,
    };
  }

  /**
   * Star ratings are rendered by the "star-rating" micro-frontend, whose
   * Apollo cache is embedded in the page as an inner JSON script tag.
   */
  private extractStarRating(
    pageProps: Record<string, unknown>,
    productId: string,
  ): StarRating | undefined {
    const batarangs = pageProps.batarangs as
      Record<string, { text?: string }> | undefined;
    const text = batarangs?.["star-rating"]?.text;
    if (!text) return undefined;

    const inner = text.match(/<script[^>]*>(.*)<\/script>/s)?.[1];
    if (!inner) return undefined;

    try {
      const payload = JSON.parse(inner) as { cache?: ApolloState };
      const cached =
        payload.cache?.[`Product:${productId}`] ??
        Object.values(payload.cache ?? {}).find(
          (v) => v.__typename === "Product" && v.starRating,
        );
      const rating = cached?.starRating as
        | {
            averageRating?: number;
            totalRatingsCount?: number;
            ratingsDistribution?: Array<{ rating: number; percentage: string }>;
          }
        | undefined;
      if (rating?.averageRating === undefined) return undefined;
      return {
        averageRating: rating.averageRating,
        totalRatingsCount: rating.totalRatingsCount ?? 0,
        ratingsDistribution: rating.ratingsDistribution?.map(
          ({ rating: r, percentage }) => ({
            rating: r,
            percentage,
          }),
        ),
      };
    } catch {
      return undefined;
    }
  }

  /** Search the store catalog (games, add-ons, bundles) by name. */
  async search(term: string): Promise<StoreItem[]> {
    const { apollo } = await this.fetchNextData(
      `/search/${encodeURIComponent(term)}`,
    );
    return Object.entries(apollo)
      .filter(
        ([key, value]) =>
          key.startsWith("Product:") &&
          value.__typename === "Product" &&
          value.name,
      )
      .map(([, value]) => this.toStoreItem(value));
  }

  /**
   * A page of deals, optionally enriched with each product's star rating
   * (one extra page fetch per product, done concurrently).
   */
  async getDeals(
    page = 1,
    includeRatings = false,
    categoryId = ALL_DEALS_CATEGORY_ID,
  ): Promise<
    CategoryGridPage & { items: Array<StoreItem & { starRating?: StarRating }> }
  > {
    const grid = await this.getCategoryGrid(categoryId, page);
    if (!includeRatings) return grid;

    const items = await mapWithConcurrency(grid.items, 6, async (item) => {
      try {
        const product = await this.getProduct(item.productId);
        return { ...item, starRating: product.starRating };
      } catch {
        return item; // rating unavailable; keep the deal itself
      }
    });
    return { ...grid, items };
  }
}

async function mapWithConcurrency<T, R>(
  inputs: readonly T[],
  concurrency: number,
  fn: (input: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(inputs.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, inputs.length) },
    async () => {
      while (next < inputs.length) {
        const index = next++;
        results[index] = await fn(inputs[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
