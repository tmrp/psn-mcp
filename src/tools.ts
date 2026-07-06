import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PsnApi } from "./psn/api.js";
import { ALL_DEALS_CATEGORY_ID, type PsnStore } from "./psn/store.js";

const userParam = z
  .string()
  .describe(
    'PSN user: "me" for the authenticated account, a PSN online id (username), or a numeric account id.',
  );

const npServiceNameParam = z
  .enum(["trophy", "trophy2"])
  .describe(
    'Trophy service: "trophy2" for PS5/PS VR2 titles, "trophy" for PS4 and earlier. ' +
      "Use the npServiceName reported by psn_get_trophy_titles.",
  );

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

/** Wraps a handler so PSN/auth failures surface as MCP tool errors, not crashes. */
function handle<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return jsonResult(await fn(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

export function registerTools(
  server: McpServer,
  psn: PsnApi,
  store: PsnStore,
): void {
  server.registerTool(
    "psn_get_profile",
    {
      title: "Get PSN profile",
      description:
        "Get a PlayStation Network user's profile: online id, about-me, avatars, " +
        "languages, and PS Plus / verification status.",
      inputSchema: { user: userParam },
    },
    handle(async ({ user }) =>
      psn.getProfile(await psn.resolveAccountId(user)),
    ),
  );

  server.registerTool(
    "psn_search_players",
    {
      title: "Search PSN players",
      description:
        "Search PlayStation Network for players by name. Returns matching online ids, " +
        "account ids, and avatars. Useful for finding a user's account id.",
      inputSchema: {
        query: z.string().describe("Name or online id to search for."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe("Max results."),
      },
    },
    handle(async ({ query, limit }) => {
      const res = await psn.searchPlayers(query, limit);
      const results = res.domainResponses[0]?.results ?? [];
      return results
        .map((r) => r.socialMetadata)
        .filter(Boolean)
        .map((m) => ({
          onlineId: m!.onlineId,
          accountId: m!.accountId,
          verifiedUserName: m!.verifiedUserName || undefined,
          avatarUrl: m!.avatarUrl,
          isPsPlus: m!.isPsPlus,
        }));
    }),
  );

  server.registerTool(
    "psn_get_friends",
    {
      title: "Get PSN friends",
      description:
        "List a user's PSN friends with their profiles. Friends lists other than your " +
        "own are only visible if that user's privacy settings allow it.",
      inputSchema: {
        user: userParam.default("me"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(50)
          .describe("Max friends to return."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Pagination offset."),
      },
    },
    handle(async ({ user, limit, offset }) => {
      const accountId = await psn.resolveAccountId(user);
      const friends = await psn.getFriends(accountId, limit, offset);
      // The friends endpoint returns bare account ids; resolve them to profiles.
      const profiles = await Promise.all(
        friends.friends.map(async (id) => {
          try {
            const profile = await psn.getProfile(id);
            return {
              accountId: id,
              onlineId: profile.onlineId,
              isPlus: profile.isPlus,
            };
          } catch {
            return { accountId: id };
          }
        }),
      );
      return {
        totalItemCount: friends.totalItemCount,
        nextOffset: friends.nextOffset,
        friends: profiles,
      };
    }),
  );

  server.registerTool(
    "psn_get_presence",
    {
      title: "Get PSN presence",
      description:
        "Get a user's current online status: whether they are online, on which " +
        "platform (PS5/PS4), what game they are playing, and when they were last online.",
      inputSchema: { user: userParam.default("me") },
    },
    handle(async ({ user }) =>
      psn.getBasicPresence(await psn.resolveAccountId(user)),
    ),
  );

  server.registerTool(
    "psn_get_trophy_summary",
    {
      title: "Get trophy summary",
      description:
        "Get a user's overall trophy summary: trophy level, tier, progress to next " +
        "level, and total bronze/silver/gold/platinum counts.",
      inputSchema: { user: userParam.default("me") },
    },
    handle(async ({ user }) =>
      psn.getTrophySummary(await psn.resolveAccountId(user)),
    ),
  );

  server.registerTool(
    "psn_get_trophy_titles",
    {
      title: "Get trophy titles",
      description:
        "List the games a user has earned trophies in, ordered by most recently " +
        "played, with per-game progress and earned counts. Returns each game's " +
        "npCommunicationId and npServiceName for use with the trophy detail tools.",
      inputSchema: {
        user: userParam.default("me"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(800)
          .default(50)
          .describe("Max titles to return."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Pagination offset."),
      },
    },
    handle(async ({ user, limit, offset }) =>
      psn.getTrophyTitles(await psn.resolveAccountId(user), limit, offset),
    ),
  );

  server.registerTool(
    "psn_get_title_trophies",
    {
      title: "Get a game's trophy list",
      description:
        "Get the full trophy list defined for a game (names, descriptions, types, " +
        "groups). Get npCommunicationId and npServiceName from psn_get_trophy_titles.",
      inputSchema: {
        npCommunicationId: z
          .string()
          .describe('Trophy set id, e.g. "NPWR20188_00".'),
        npServiceName: npServiceNameParam,
        trophyGroupId: z
          .string()
          .default("all")
          .describe(
            'Trophy group: "all", "default" (base game), or "001", "002"... for DLC.',
          ),
        limit: z.number().int().min(1).max(500).default(200),
        offset: z.number().int().min(0).default(0),
      },
    },
    handle(
      ({ npCommunicationId, npServiceName, trophyGroupId, limit, offset }) =>
        psn.getTitleTrophies(
          npCommunicationId,
          npServiceName,
          trophyGroupId,
          limit,
          offset,
        ),
    ),
  );

  server.registerTool(
    "psn_get_earned_trophies",
    {
      title: "Get a user's earned trophies for a game",
      description:
        "Get which trophies a user has earned in a specific game, including earned " +
        "timestamps and global rarity. Combine with psn_get_title_trophies for trophy " +
        "names and descriptions (this endpoint returns ids and earned state).",
      inputSchema: {
        user: userParam.default("me"),
        npCommunicationId: z
          .string()
          .describe('Trophy set id, e.g. "NPWR20188_00".'),
        npServiceName: npServiceNameParam,
        trophyGroupId: z.string().default("all"),
        limit: z.number().int().min(1).max(500).default(200),
        offset: z.number().int().min(0).default(0),
      },
    },
    handle(
      async ({
        user,
        npCommunicationId,
        npServiceName,
        trophyGroupId,
        limit,
        offset,
      }) =>
        psn.getEarnedTrophies(
          await psn.resolveAccountId(user),
          npCommunicationId,
          npServiceName,
          trophyGroupId,
          limit,
          offset,
        ),
    ),
  );

  server.registerTool(
    "psn_get_played_games",
    {
      title: "Get played games",
      description:
        "List the PS4/PS5 games a user has played, with play counts, first/last " +
        "played dates, and total play duration. Subject to the user's privacy settings.",
      inputSchema: {
        user: userParam.default("me"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .describe("Max games to return."),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Pagination offset."),
      },
    },
    handle(async ({ user, limit, offset }) =>
      psn.getPlayedGames(await psn.resolveAccountId(user), limit, offset),
    ),
  );

  // ---- PlayStation Store (no PSN account required) -----------------------

  server.registerTool(
    "psn_get_store_deals",
    {
      title: "Get PlayStation Store deals",
      description:
        "List games currently on sale on the PlayStation Store, with base price, " +
        "sale price, and discount percentage. Set includeRatings to also fetch each " +
        "game's community star rating (0-5) and rating count - useful for ranking " +
        "deals by review score. Returns 24 items per page; pass page to paginate. " +
        "Store region comes from the PSN_STORE_LOCALE env var (default en-us).",
      inputSchema: {
        page: z
          .number()
          .int()
          .min(1)
          .default(1)
          .describe("Grid page (24 deals per page)."),
        includeRatings: z
          .boolean()
          .default(false)
          .describe(
            "Also fetch each product's star rating (slower: one extra fetch per item).",
          ),
        categoryId: z
          .string()
          .default(ALL_DEALS_CATEGORY_ID)
          .describe(
            'Store category to browse; defaults to the "All deals" category.',
          ),
      },
    },
    handle(({ page, includeRatings, categoryId }) =>
      store.getDeals(page, includeRatings, categoryId),
    ),
  );

  server.registerTool(
    "psn_get_store_product",
    {
      title: "Get PlayStation Store product",
      description:
        "Get a store product's details: current price, discount, platforms, and " +
        "community star rating with rating count and distribution. Product ids look " +
        'like "UP0006-PPSA27360_00-26STANDARDBUNDLE" and come from psn_get_store_deals ' +
        "or psn_search_store.",
      inputSchema: {
        productId: z.string().describe("PlayStation Store product id."),
      },
    },
    handle(({ productId }) => store.getProduct(productId)),
  );

  server.registerTool(
    "psn_search_store",
    {
      title: "Search the PlayStation Store",
      description:
        "Search the PlayStation Store catalog for games, bundles, and add-ons by " +
        "name. Returns product ids, current prices, and any active discounts.",
      inputSchema: {
        query: z.string().describe("Game or product name to search for."),
      },
    },
    handle(({ query }) => store.search(query)),
  );
}
