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

import { mapWithConcurrency } from "./concurrency.js";

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

interface ApolloRef {
  __ref?: string;
}

interface BatarangPayload {
  cache?: ApolloState;
}

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

  private toStorePrice(value: unknown): StorePrice | undefined {
    if (!value || typeof value !== "object") return undefined;
    const price = value as Record<string, unknown>;
    const discountText = [
      price.discountText,
      price.displayDiscountText,
      price.savingTag,
    ].find(
      (field): field is string => typeof field === "string" && field.length > 0,
    );
    const normalized: StorePrice = {
      basePrice:
        typeof price.basePrice === "string" ? price.basePrice : undefined,
      discountedPrice:
        typeof price.discountedPrice === "string"
          ? price.discountedPrice
          : undefined,
      discountText,
      isFree: typeof price.isFree === "boolean" ? price.isFree : undefined,
      isTiedToSubscription:
        typeof price.isTiedToSubscription === "boolean"
          ? price.isTiedToSubscription
          : undefined,
    };
    return Object.values(normalized).some((field) => field !== undefined)
      ? normalized
      : undefined;
  }

  private toStoreItem(
    entity: ApolloEntity,
    priceOverride?: StorePrice,
  ): StoreItem {
    const price = priceOverride ?? this.toStorePrice(entity.price);
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
      price,
      imageUrl: image?.url,
    };
  }

  private extractBatarangCaches(
    pageProps: Record<string, unknown>,
  ): ApolloState[] {
    const batarangs = pageProps.batarangs as
      Record<string, { text?: string }> | undefined;
    const caches: ApolloState[] = [];

    for (const batarang of Object.values(batarangs ?? {})) {
      const text = batarang.text;
      if (!text) continue;
      const inner = text.match(/<script[^>]*>(.*)<\/script>/s)?.[1];
      if (!inner) continue;
      try {
        const payload = JSON.parse(inner) as BatarangPayload;
        if (payload.cache) caches.push(payload.cache);
      } catch {
        // A malformed optional micro-frontend must not hide the base product.
      }
    }
    return caches;
  }

  private mergeProductEntities(
    states: ApolloState[],
    productId: string,
  ): ApolloEntity | undefined {
    const matches: ApolloEntity[] = [];
    for (const state of states) {
      for (const [key, value] of Object.entries(state)) {
        const productKey = `Product:${productId}`;
        if (
          (key === productKey ||
            key.startsWith(`${productKey}:`) ||
            (value.__typename === "Product" && value.id === productId)) &&
          !matches.includes(value)
        ) {
          matches.push(value);
        }
      }
    }
    return matches.length > 0 ? Object.assign({}, ...matches) : undefined;
  }

  private findProductPrice(
    product: ApolloEntity,
    states: ApolloState[],
    productId: string,
  ): StorePrice | undefined {
    const direct = this.toStorePrice(product.price);
    if (direct) return direct;

    const ctaRefs = (product.webctas as ApolloRef[] | undefined) ?? [];
    for (const ref of ctaRefs) {
      if (!ref.__ref) continue;
      for (const state of states) {
        const price = this.toStorePrice(state[ref.__ref]?.price);
        if (price) return price;
      }
    }

    // Current product pages keep the price on a GameCTA entity in a
    // micro-frontend cache. The primary product id is part of that entity key.
    for (const state of states) {
      for (const [key, value] of Object.entries(state)) {
        const matchesProduct = key.split(":").some((segment) => {
          if (segment === productId) return true;
          const skuSuffix = segment.slice(productId.length);
          return (
            segment.startsWith(`${productId}-U`) && /^-U\d+$/.test(skuSuffix)
          );
        });
        if (value.__typename !== "GameCTA" || !matchesProduct) {
          continue;
        }
        const price = this.toStorePrice(value.price);
        if (price) return price;
      }
    }
    return undefined;
  }

  private toStarRating(value: unknown): StarRating | undefined {
    if (!value || typeof value !== "object") return undefined;
    const rating = value as {
      averageRating?: number;
      totalRatingsCount?: number;
      ratingsDistribution?: Array<{ rating: number; percentage: string }>;
    };
    if (rating.averageRating === undefined) return undefined;
    return {
      averageRating: rating.averageRating,
      totalRatingsCount: rating.totalRatingsCount ?? 0,
      ratingsDistribution: rating.ratingsDistribution?.map(
        ({ rating: score, percentage }) => ({ rating: score, percentage }),
      ),
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

    // Sony now normalizes product pages across several independently rendered
    // micro-frontends. Merge every fragment for this exact product so the
    // result contains the image/platform/type fields as well as the base name.
    const states = [apollo, ...this.extractBatarangCaches(pageProps)];
    const entity = this.mergeProductEntities(states, productId);
    if (!entity) {
      throw new PsnStoreError(
        `Product ${productId} not found on the PlayStation Store.`,
      );
    }

    const concept = entity.concept as
      { __ref?: string; id?: string | number } | undefined;
    const conceptId =
      entity.conceptId == null
        ? (concept?.id?.toString() ?? concept?.__ref?.replace(/^Concept:/, ""))
        : String(entity.conceptId);

    return {
      ...this.toStoreItem(
        entity,
        this.findProductPrice(entity, states, productId),
      ),
      starRating:
        this.toStarRating(entity.starRating) ??
        this.extractStarRating(pageProps, productId),
      conceptId,
      url: `${STORE_BASE}/${this.locale}/product/${encodeURIComponent(productId)}`,
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
      const payload = JSON.parse(inner) as BatarangPayload;
      const cached =
        payload.cache?.[`Product:${productId}`] ??
        Object.values(payload.cache ?? {}).find(
          (v) =>
            v.__typename === "Product" && v.id === productId && v.starRating,
        );
      return this.toStarRating(cached?.starRating);
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
