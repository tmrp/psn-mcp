import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { PsnApi } from "../psn/api.js";
import type { TokenManager } from "../psn/auth.js";
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

function game(id: number, membership: string | null = "NONE"): PurchasedGame {
  return {
    titleId: `title-${id}`,
    name: `Game ${id}`,
    platform: "PS5",
    productId: `product-${id}`,
    entitlementId: `entitlement-${id}`,
    membership,
  };
}

interface LibraryVariables {
  start: number;
  size: number;
  platform: string[];
  isActive: boolean;
  sortBy: string;
  sortDirection: string;
  membership?: string;
}

function mockLibrary(
  games: PurchasedGame[],
  options: {
    rawPageSize?: number;
    omitPageInfo?: boolean;
    onPage?: (variables: LibraryVariables) => Response | undefined;
    history?: (url: URL) => Response;
  } = {},
) {
  const calls: LibraryVariables[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (
      url.pathname === "/api/gamelist/v2/users/me/titles" &&
      options.history
    ) {
      return options.history(url);
    }
    assert.equal(url.pathname, "/api/graphql/v1/op");
    const variables: LibraryVariables = JSON.parse(
      url.searchParams.get("variables")!,
    );
    calls.push(variables);
    const response = options.onPage?.(variables);
    if (response) return response;
    // Replay Sony's observed behavior: NONE returns no entries, even when
    // the unfiltered pages contain entitlements with that membership.
    const matches =
      variables.membership === "NONE"
        ? []
        : variables.membership === "PS_PLUS"
          ? games.filter((game) => game.membership === "PS_PLUS")
          : games;
    const size = Math.min(
      variables.size,
      options.rawPageSize ?? variables.size,
    );
    return Response.json({
      data: {
        purchasedTitlesRetrieve: {
          games: matches.slice(variables.start, variables.start + size),
          ...(!options.omitPageInfo
            ? {
                pageInfo: {
                  offset: variables.start,
                  size,
                  isLast: variables.start + size >= matches.length,
                  totalCount: matches.length,
                },
              }
            : {}),
        },
      },
    });
  };
  return calls;
}

const noneOptions = { membership: "NONE", includePlayTime: false } as const;

test("NONE filters across raw pages and applies offsets to matching entitlements", async () => {
  const games = [
    game(0, "PS_PLUS"),
    game(1),
    game(2),
    game(3, "PS_PLUS"),
    game(4),
    game(5, "PS_PLUS"),
    game(6),
    game(7, "PS_PLUS"),
    game(8, "PS_PLUS"),
    game(9),
  ];
  const calls = mockLibrary(games, { rawPageSize: 3 });
  const options = {
    ...noneOptions,
    limit: 2,
    platform: ["ps5"] as "ps5"[],
    isActive: false,
    sortDirection: "asc" as const,
  };
  assert.deepEqual(await api.getPurchasedGames({ ...options, offset: 1 }), {
    games: [games[2], games[4]],
    nextOffset: 3,
  });
  assert.deepEqual(
    calls.map((call) => call.start),
    [0, 3, 6],
  );
  for (const { start, ...variables } of calls) {
    assert.deepEqual(variables, {
      size: 100,
      platform: ["ps5"],
      isActive: false,
      sortBy: "ACTIVE_DATE",
      sortDirection: "asc",
    });
  }
  calls.length = 0;
  assert.deepEqual(await api.getPurchasedGames({ ...options, offset: 3 }), {
    games: [games[6], games[9]],
    totalItemCount: 5,
    pageInfo: { offset: 3, size: 2, totalCount: 5, isLast: true },
  });
  assert.deepEqual(
    calls.map((call) => call.start),
    [0, 3, 6, 9],
  );
});

test("NONE looks past a full filtered page before claiming another page exists", async () => {
  const games = [
    game(0, "PS_PLUS"),
    game(1),
    game(2, "PS_PLUS"),
    game(3),
    game(4, "PS_PLUS"),
    game(5, "PS_PLUS"),
    game(6, "PS_PLUS"),
  ];
  const calls = mockLibrary(games, { rawPageSize: 3 });
  assert.deepEqual(await api.getPurchasedGames({ ...noneOptions, limit: 2 }), {
    games: [games[1], games[3]],
    totalItemCount: 2,
    pageInfo: { offset: 0, size: 2, totalCount: 2, isLast: true },
  });
  assert.deepEqual(
    calls.map((call) => call.start),
    [0, 3, 6],
  );
});

test("NONE counts exact memberships without deduplicating titles or subtracting PS Plus", async () => {
  const games = [
    game(0, "PS_PLUS"),
    game(1, "OTHER"),
    game(2, null),
    { ...game(3), membership: undefined },
    game(4),
    { ...game(4), entitlementId: "another-license" },
  ];
  mockLibrary(games);
  assert.deepEqual(await api.getPurchasedGames({ ...noneOptions, limit: 1 }), {
    games: [games[4]],
    totalItemCount: 2,
    pageInfo: { offset: 0, size: 1, totalCount: 2, isLast: false },
    nextOffset: 1,
  });
});

test("NONE returns accurate empty pages when no entries match or offset exceeds the matches", async () => {
  const calls = mockLibrary([game(0, "PS_PLUS"), game(1, "PS_PLUS")], {
    rawPageSize: 1,
  });
  assert.deepEqual(await api.getPurchasedGames({ ...noneOptions, limit: 2 }), {
    games: [],
    totalItemCount: 0,
    pageInfo: { offset: 0, size: 2, totalCount: 0, isLast: true },
  });
  assert.deepEqual(
    calls.map((call) => call.start),
    [0, 1],
  );
  mockLibrary([game(0), game(1, "PS_PLUS")]);
  assert.deepEqual(
    await api.getPurchasedGames({ ...noneOptions, limit: 2, offset: 10 }),
    {
      games: [],
      totalItemCount: 1,
      pageInfo: { offset: 10, size: 2, totalCount: 1, isLast: true },
    },
  );
});

test("NONE scans full pages without metadata until a short page establishes the filtered total", async () => {
  const games = [
    ...Array.from({ length: 100 }, (_, id) => game(id, "PS_PLUS")),
    game(100),
    game(101),
  ];
  const calls = mockLibrary(games, { omitPageInfo: true });
  assert.deepEqual(await api.getPurchasedGames({ ...noneOptions, limit: 1 }), {
    games: [games[100]],
    totalItemCount: 2,
    nextOffset: 1,
    pageInfo: { offset: 0, size: 1, totalCount: 2, isLast: false },
  });
  assert.deepEqual(
    calls.map((call) => call.start),
    [0, 100],
  );
});

test("NONE probes beyond a full final raw page when pagination metadata is absent", async () => {
  const games = Array.from({ length: 100 }, (_, id) =>
    game(id, id === 99 ? "NONE" : "PS_PLUS"),
  );
  const calls = mockLibrary(games, { omitPageInfo: true });
  assert.deepEqual(await api.getPurchasedGames({ ...noneOptions, limit: 1 }), {
    games: [games[99]],
    totalItemCount: 1,
    pageInfo: { offset: 0, size: 1, totalCount: 1, isLast: true },
  });
  assert.deepEqual(
    calls.map((call) => call.start),
    [0, 100],
  );
});

test("NONE propagates later raw-page failures instead of returning a partial library", async () => {
  mockLibrary([game(0), game(1)], {
    rawPageSize: 1,
    onPage: ({ start }) =>
      start === 1
        ? Response.json(
            { errors: [{ message: "Library unavailable" }] },
            { status: 503 },
          )
        : undefined,
  });
  await assert.rejects(
    api.getPurchasedGames({ ...noneOptions, limit: 2 }),
    (error) => {
      assert.ok(error instanceof PsnApiError);
      assert.equal(error.status, 503);
      assert.match(error.message, /Library unavailable/);
      return true;
    },
  );
});

test("NONE enriches only the returned filtered page with play time", async () => {
  let historyCalls = 0;
  const games = [game(0, "PS_PLUS"), game(1), game(2)];
  mockLibrary(games, {
    history: (url) => {
      historyCalls++;
      assert.equal(url.searchParams.get("offset"), "0");
      return Response.json({
        titles: [{ titleId: games[2].titleId, playDuration: "PT1H" }],
        totalItemCount: 100,
        nextOffset: 1,
      });
    },
  });
  const result = await api.getPurchasedGames({
    membership: "NONE",
    offset: 1,
    limit: 1,
  });
  assert.equal(historyCalls, 1);
  assert.equal(result.games.length, 1);
  assert.equal(result.games[0].titleId, games[2].titleId);
  assert.equal(result.games[0].playDuration, "PT1H");
  assert.equal(result.totalItemCount, 2);
  assert.equal(result.nextOffset, undefined);
  assert.equal(result.playTimeError, undefined);
});

test("NONE pagination returns each matching entitlement once in library order", async () => {
  const games = Array.from({ length: 41 }, (_, id) =>
    game(id, id % 3 === 0 ? "NONE" : "PS_PLUS"),
  );
  mockLibrary(games, { rawPageSize: 5 });
  const expected = games.filter((game) => game.membership === "NONE");
  const returned: PurchasedGame[] = [];
  let offset = 0;
  while (true) {
    const result = await api.getPurchasedGames({
      ...noneOptions,
      limit: 3,
      offset,
    });
    returned.push(...result.games);
    assert.deepEqual(result.games, expected.slice(offset, offset + 3));
    if (result.pageInfo) {
      assert.equal(result.pageInfo.offset, offset);
      assert.equal(result.pageInfo.totalCount, expected.length);
      assert.equal(result.pageInfo.isLast, result.nextOffset === undefined);
    }
    if (result.nextOffset === undefined) {
      assert.equal(result.totalItemCount, expected.length);
      break;
    }
    assert.equal(result.nextOffset, offset + 3);
    assert.ok(result.nextOffset < expected.length);
    offset = result.nextOffset;
  }
  assert.deepEqual(returned, expected);
});

test("NONE rejects invalid or non-advancing raw pagination instead of looping or inventing a total", async () => {
  const validInfo = { offset: 0, size: 1, totalCount: 10, isLast: false };
  for (const pageInfo of [
    { ...validInfo, size: 0 },
    { ...validInfo, size: -1 },
    { ...validInfo, size: 1.5 },
    { ...validInfo, offset: 1 },
    { ...validInfo, isLast: "false" },
    { ...validInfo, totalCount: null },
    { ...validInfo, totalCount: 1 },
    validInfo, // Repeats offset zero when the next raw page is requested.
  ]) {
    const calls = mockLibrary([], {
      onPage: () =>
        Response.json({
          data: {
            purchasedTitlesRetrieve: { games: [game(0, "PS_PLUS")], pageInfo },
          },
        }),
    });
    await assert.rejects(
      api.getPurchasedGames(noneOptions),
      /invalid pagination/,
    );
    assert.ok(calls.length <= 2);
  }
  mockLibrary([], {
    onPage: () =>
      Response.json({
        data: { purchasedTitlesRetrieve: { games: [], pageInfo: validInfo } },
      }),
  });
  await assert.rejects(
    api.getPurchasedGames(noneOptions),
    /invalid pagination/,
  );
});

test("NONE propagates GraphQL and malformed-data failures on later pages", async () => {
  for (const body of [
    { errors: [{ message: "Library unavailable" }] },
    { data: { purchasedTitlesRetrieve: { games: null } } },
  ]) {
    mockLibrary([game(0), game(1)], {
      rawPageSize: 1,
      onPage: ({ start }) => (start === 1 ? Response.json(body) : undefined),
    });
    await assert.rejects(
      api.getPurchasedGames(noneOptions),
      /Library unavailable|no valid game list/,
    );
  }
});

test("NONE retains filtered games and metadata if play history fails", async () => {
  const games = [game(0, "PS_PLUS"), game(1)];
  mockLibrary(games, {
    history: () =>
      Response.json(
        { error: { message: "History unavailable" } },
        { status: 503 },
      ),
  });
  const result = await api.getPurchasedGames({ membership: "NONE", limit: 1 });
  assert.deepEqual(result.games, [games[1]]);
  assert.equal(result.totalItemCount, 1);
  assert.equal(result.pageInfo?.isLast, true);
  assert.match(result.playTimeError!, /History unavailable/);
});
