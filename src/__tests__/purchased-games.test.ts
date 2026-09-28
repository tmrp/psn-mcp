import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { PsnApi } from "../psn/api.js";
import { TokenManager } from "../psn/auth.js";
import { PsnApiError, PsnHttpClient } from "../psn/http.js";
import type { PurchasedGame } from "../psn/types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const api = new PsnApi(
  new PsnHttpClient({
    getAccessToken: async () => "test-token",
  } as TokenManager),
);

const game = {
  titleId: "PPSA00001_00",
  name: "Unplayed game",
  platform: "PS5",
  productId: "EP0001-PPSA00001_00-EXAMPLEGAME000001",
  entitlementId: "entitlement-1",
  conceptId: null,
  image: { url: "https://example.com/cover.png" },
  isActive: true,
  isDownloadable: false,
  isPreOrder: true,
  membership: "NONE",
};

test("purchased games uses authenticated web GraphQL and retains all metadata", async () => {
  const pageInfo = { isLast: false, offset: 0, size: 50, totalCount: 75 };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "https://web.np.playstation.com");
    assert.equal(url.pathname, "/api/graphql/v1/op");
    assert.equal(init?.method, "GET");
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      "Bearer test-token",
    );
    assert.equal(url.searchParams.get("operationName"), "getPurchasedGameList");
    assert.deepEqual(JSON.parse(url.searchParams.get("variables")!), {
      isActive: true,
      platform: ["ps4", "ps5"],
      size: 50,
      start: 0,
      sortBy: "ACTIVE_DATE",
      sortDirection: "desc",
    });
    assert.deepEqual(JSON.parse(url.searchParams.get("extensions")!), {
      persistedQuery: {
        version: 1,
        sha256Hash:
          "827a423f6a8ddca4107ac01395af2ec0eafd8396fc7fa204aaf9b7ed2eefa168",
      },
    });
    return Response.json({
      data: { purchasedTitlesRetrieve: { games: [game], pageInfo } },
    });
  };

  assert.deepEqual(await api.getPurchasedGames({ includePlayTime: false }), {
    games: [game],
    pageInfo,
    totalItemCount: 75,
    nextOffset: 50,
  });
});

test("purchased games passes filters and stops pagination on the last page", async () => {
  const pageInfo = { isLast: true, offset: 20, size: 10, totalCount: 21 };
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    assert.deepEqual(JSON.parse(url.searchParams.get("variables")!), {
      isActive: false,
      platform: ["ps5"],
      size: 10,
      start: 20,
      sortBy: "ACTIVE_DATE",
      sortDirection: "asc",
      membership: "PS_PLUS",
    });
    return Response.json({
      data: { purchasedTitlesRetrieve: { games: [game], pageInfo } },
    });
  };

  assert.deepEqual(
    await api.getPurchasedGames({
      limit: 10,
      offset: 20,
      platform: ["ps5"],
      isActive: false,
      membership: "PS_PLUS",
      sortDirection: "asc",
      includePlayTime: false,
    }),
    { games: [game], pageInfo, totalItemCount: 21 },
  );
});

test("purchased games paginates without pageInfo and stops on short or empty pages", async () => {
  let games = [game, { ...game, titleId: "PPSA00002_00" }];
  globalThis.fetch = async () =>
    Response.json({
      data: { purchasedTitlesRetrieve: { games } },
    });
  assert.deepEqual(
    await api.getPurchasedGames({
      limit: 2,
      offset: 10,
      includePlayTime: false,
    }),
    {
      games,
      nextOffset: 12,
    },
  );
  games = [game];
  assert.deepEqual(
    await api.getPurchasedGames({
      limit: 2,
      offset: 12,
      includePlayTime: false,
    }),
    {
      games,
    },
  );
  games = [];
  assert.deepEqual(await api.getPurchasedGames({ limit: 2, offset: 14 }), {
    games: [],
  });
});

test("purchased games follows the server page size when it differs from the requested limit", async () => {
  const pageInfo = { isLast: false, offset: 20, size: 10, totalCount: 75 };
  globalThis.fetch = async () =>
    Response.json({
      data: { purchasedTitlesRetrieve: { games: [game], pageInfo } },
    });
  assert.equal(
    (
      await api.getPurchasedGames({
        limit: 50,
        offset: 20,
        includePlayTime: false,
      })
    ).nextOffset,
    30,
  );
});

test("purchased games does not loop on an empty page with inconsistent pageInfo", async () => {
  const pageInfo = { isLast: false, offset: 50, size: 50, totalCount: 100 };
  globalThis.fetch = async () =>
    Response.json({
      data: { purchasedTitlesRetrieve: { games: [], pageInfo } },
    });
  assert.deepEqual(await api.getPurchasedGames({ offset: 50 }), {
    games: [],
    pageInfo,
    totalItemCount: 100,
  });
});

test("purchased games rejects GraphQL errors even with partial data and HTTP 200", async () => {
  for (const data of [null, { purchasedTitlesRetrieve: { games: [game] } }]) {
    globalThis.fetch = async () =>
      Response.json({
        data,
        errors: [{ message: "PersistedQueryNotFound" }],
      });
    await assert.rejects(api.getPurchasedGames(), /PersistedQueryNotFound/);
  }
});

test("purchased games rejects missing or malformed data instead of returning an empty library", async () => {
  for (const response of [
    null,
    {},
    { data: null },
    { data: {} },
    { data: { purchasedTitlesRetrieve: null } },
    { data: { purchasedTitlesRetrieve: {} } },
    { data: { purchasedTitlesRetrieve: { games: "invalid" } } },
  ]) {
    globalThis.fetch = async () => Response.json(response);
    await assert.rejects(api.getPurchasedGames(), /no valid game list/);
  }
});

test("purchased games propagates HTTP errors", async () => {
  globalThis.fetch = async () =>
    Response.json({ error: { message: "Unauthorized" } }, { status: 401 });
  await assert.rejects(api.getPurchasedGames(), (error) => {
    assert.ok(error instanceof PsnApiError);
    assert.equal(error.status, 401);
    return true;
  });
});

test("purchased games requires credentials before making a request", async () => {
  globalThis.fetch = async () => {
    throw new Error("unexpected network request");
  };
  const unauthenticated = new PsnApi(new PsnHttpClient(new TokenManager()));
  await assert.rejects(
    unauthenticated.getPurchasedGames(),
    /No NPSSO token configured/,
  );
});

function mockLibraryAndHistory(
  games: PurchasedGame[],
  history: (url: URL) => Response,
) {
  const historyOffsets: number[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/graphql/v1/op") {
      assert.equal(
        "includePlayTime" in JSON.parse(url.searchParams.get("variables")!),
        false,
      );
      return Response.json({ data: { purchasedTitlesRetrieve: { games } } });
    }
    assert.equal(url.origin, "https://m.np.playstation.com");
    assert.equal(url.pathname, "/api/gamelist/v2/users/me/titles");
    assert.equal(url.searchParams.get("limit"), "200");
    historyOffsets.push(Number(url.searchParams.get("offset")));
    return history(url);
  };
  return historyOffsets;
}

test("play time joins exact title IDs across history pages and preserves library order and pagination", async () => {
  const otherPlatform = { ...game, titleId: "CUSA00001_00", platform: "PS4" };
  const games = [
    game,
    otherPlatform,
    { ...game, entitlementId: "another-license" },
  ];
  const played = {
    titleId: game.titleId,
    name: "A different localized name",
    playDuration: "PT12H30M15S",
    playCount: 7,
    firstPlayedDateTime: "2025-01-01T12:00:00Z",
    lastPlayedDateTime: "2026-09-27T12:00:00Z",
  };
  const offsets = mockLibraryAndHistory(games, (url) => {
    const offset = Number(url.searchParams.get("offset"));
    return Response.json(
      offset === 0
        ? {
            titles: [{ ...played, titleId: "PPSA99999_00", name: game.name }],
            totalItemCount: 2,
            nextOffset: 1,
          }
        : { titles: [played], totalItemCount: 2 },
    );
  });
  const result = await api.getPurchasedGames({
    includePlayTime: true,
    limit: 3,
    offset: 20,
  });
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(result.nextOffset, 23);
  const { titleId, name, ...playMetadata } = played;
  assert.deepEqual(result.games, [
    { ...game, ...playMetadata },
    otherPlatform,
    { ...games[2], ...playMetadata },
  ]);
  assert.equal(result.playTimeError, undefined);
});

test("play time is included by default, stops once all titles match, and preserves zero duration", async () => {
  const offsets = mockLibraryAndHistory([game], () =>
    Response.json({
      titles: [{ titleId: game.titleId, playDuration: "PT0S", playCount: 0 }],
      totalItemCount: 500,
      nextOffset: 200,
    }),
  );
  const result = await api.getPurchasedGames();
  assert.deepEqual(offsets, [0]);
  assert.equal(result.games[0].playDuration, "PT0S");
  assert.equal(result.games[0].playCount, 0);
  assert.equal(result.games[0].lastPlayedDateTime, undefined);
});

test("play time follows totalItemCount when history omits nextOffset", async () => {
  const offsets = mockLibraryAndHistory([game], (url) =>
    Response.json({
      titles: [
        {
          titleId:
            Number(url.searchParams.get("offset")) === 0
              ? "OTHER"
              : game.titleId,
          playDuration: "PT2H",
        },
      ],
      totalItemCount: 2,
    }),
  );
  const result = await api.getPurchasedGames({ includePlayTime: true });
  assert.deepEqual(offsets, [0, 1]);
  assert.equal(result.games[0].playDuration, "PT2H");
});

test("play time makes no history requests when disabled or the purchased page is empty", async () => {
  const disabledOffsets = mockLibraryAndHistory([game], () => {
    throw new Error("unexpected history request");
  });
  assert.deepEqual(await api.getPurchasedGames({ includePlayTime: false }), {
    games: [game],
  });
  assert.deepEqual(disabledOffsets, []);
  const offsets = mockLibraryAndHistory([], () => {
    throw new Error("unexpected history request");
  });
  assert.deepEqual(await api.getPurchasedGames(), {
    games: [],
  });
  assert.deepEqual(offsets, []);
});

test("empty history and missing durations do not fabricate zero play time", async () => {
  for (const titles of [[], [{ titleId: game.titleId, playCount: 1 }]]) {
    mockLibraryAndHistory([game], () =>
      Response.json({ titles, totalItemCount: titles.length }),
    );
    const result = await api.getPurchasedGames({ includePlayTime: true });
    assert.equal(result.games[0].playDuration, undefined);
    assert.equal(result.playTimeError, undefined);
  }
});

test("a later history failure preserves purchased games and reports unavailable play time", async () => {
  const games = [game, { ...game, titleId: "PPSA00002_00" }];
  const offsets = mockLibraryAndHistory(games, (url) =>
    Number(url.searchParams.get("offset")) === 0
      ? Response.json({
          titles: [{ titleId: game.titleId, playDuration: "PT3H" }],
          totalItemCount: 2,
          nextOffset: 1,
        })
      : Response.json({ error: { message: "Not permitted" } }, { status: 403 }),
  );
  const result = await api.getPurchasedGames({
    includePlayTime: true,
    limit: 2,
  });
  assert.deepEqual(offsets, [0, 1]);
  assert.deepEqual(result.games, games);
  assert.equal(result.nextOffset, 2);
  assert.match(result.playTimeError!, /Not permitted/);
});

test("malformed history and non-advancing pagination report errors without looping", async () => {
  for (const response of [
    {},
    { titles: [{ titleId: "OTHER" }] },
    { titles: [{ titleId: "OTHER" }], totalItemCount: 2, nextOffset: 0 },
  ]) {
    const offsets = mockLibraryAndHistory([game], () =>
      Response.json(response),
    );
    const result = await api.getPurchasedGames({ includePlayTime: true });
    assert.deepEqual(result.games, [game]);
    assert.match(
      result.playTimeError!,
      /no valid game list|invalid pagination/,
    );
    assert.deepEqual(offsets, [0]);
  }
});
