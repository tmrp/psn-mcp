import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PsnStore } from "../src/psn/store.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function storePage(nextData: object): Response {
  // Next.js escapes "<" inside the JSON blob so nested markup (like the
  // star-rating payload's own <script> tag) can't terminate the outer tag.
  const json = JSON.stringify(nextData).replace(/</g, "\\u003c");
  const html =
    "<html><head><title>All deals | PlayStation Store</title></head><body>" +
    `<script id="__NEXT_DATA__" type="application/json">${json}</script>` +
    "</body></html>";
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html" },
  });
}

const productEntity = {
  __typename: "Product",
  id: "UP0000-PPSA00000_00-EXAMPLE",
  name: "Example Game",
  platforms: ["PS5"],
  storeDisplayClassification: "FULL_GAME",
  price: {
    basePrice: "$59.99",
    discountedPrice: "$19.79",
    discountText: "-67%",
    isFree: false,
  },
  media: [
    { type: "IMAGE", role: "MASTER", url: "https://img.example/master.png" },
  ],
};

test("getCategoryGrid resolves products from the embedded Apollo state", async () => {
  globalThis.fetch = async () =>
    storePage({
      props: {
        apolloState: {
          "CategoryGrid:cat-1:en-us:0:24": {
            __typename: "CategoryGrid",
            pageInfo: { totalCount: 321 },
            products: [{ __ref: "Product:UP0000-PPSA00000_00-EXAMPLE" }],
          },
          "Product:UP0000-PPSA00000_00-EXAMPLE": productEntity,
        },
      },
    });

  const store = new PsnStore("en-us");
  const grid = await store.getCategoryGrid("cat-1", 1);
  assert.equal(grid.totalCount, 321);
  assert.equal(grid.categoryName, "All deals");
  assert.equal(grid.items.length, 1);
  assert.equal(grid.items[0].name, "Example Game");
  assert.equal(grid.items[0].price?.discountText, "-67%");
  assert.equal(grid.items[0].imageUrl, "https://img.example/master.png");
});

test("getProduct parses the star-rating micro-frontend payload", async () => {
  const ratingCache = {
    cache: {
      "Product:UP0000-PPSA00000_00-EXAMPLE": {
        __typename: "Product",
        id: "UP0000-PPSA00000_00-EXAMPLE",
        starRating: {
          averageRating: 4.61,
          totalRatingsCount: 12345,
          ratingsDistribution: [{ rating: 5, percentage: "78%" }],
        },
      },
    },
  };
  globalThis.fetch = async () =>
    storePage({
      props: {
        apolloState: { "Product:UP0000-PPSA00000_00-EXAMPLE": productEntity },
        pageProps: {
          batarangs: {
            "star-rating": {
              text: `<script id="env:x" type="application/json">${JSON.stringify(ratingCache)}</script>`,
            },
          },
        },
      },
    });

  const store = new PsnStore("en-us");
  const product = await store.getProduct("UP0000-PPSA00000_00-EXAMPLE");
  assert.equal(product.name, "Example Game");
  assert.equal(product.starRating?.averageRating, 4.61);
  assert.equal(product.starRating?.totalRatingsCount, 12345);
  assert.deepEqual(product.starRating?.ratingsDistribution, [
    { rating: 5, percentage: "78%" },
  ]);
});

test("getProduct omits the rating when the micro-frontend payload is absent", async () => {
  globalThis.fetch = async () =>
    storePage({
      props: {
        apolloState: { "Product:UP0000-PPSA00000_00-EXAMPLE": productEntity },
        pageProps: {},
      },
    });

  const store = new PsnStore("en-us");
  const product = await store.getProduct("UP0000-PPSA00000_00-EXAMPLE");
  assert.equal(product.starRating, undefined);
});

test("search returns products from the server-rendered results", async () => {
  globalThis.fetch = async () =>
    storePage({
      props: {
        apolloState: {
          "Product:UP0000-PPSA00000_00-EXAMPLE": productEntity,
          "Concept:123": {
            __typename: "Concept",
            id: "123",
            name: "Ignored Concept",
          },
        },
      },
    });

  const store = new PsnStore("en-us");
  const results = await store.search("example");
  assert.equal(results.length, 1);
  assert.equal(results[0].productId, "UP0000-PPSA00000_00-EXAMPLE");
});
