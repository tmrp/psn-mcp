import { PsnHttpClient } from "./http.js";
import type {
  BasicPresence,
  FriendsResponse,
  PlayedGame,
  PlayedGamesResponse,
  PurchasedGame,
  PurchasedGamesPageInfo,
  PurchasedGamesResponse,
  TrophiesResponse,
  TrophySummary,
  TrophyTitlesResponse,
  UniversalSearchResponse,
  UserProfile,
} from "./types.js";

export type NpServiceName = "trophy" | "trophy2";

export interface PurchasedGamesOptions {
  limit?: number;
  offset?: number;
  platform?: Array<"ps4" | "ps5">;
  isActive?: boolean;
  membership?: "NONE" | "PS_PLUS";
  sortDirection?: "asc" | "desc";
  includePlayTime?: boolean;
}

// Sony's library accepts persisted queries only. Reference:
// https://github.com/achievements-app/psn-api/blob/main/src/graphql/operationHashes.ts
const PURCHASED_GAMES_QUERY_HASH =
  "827a423f6a8ddca4107ac01395af2ec0eafd8396fc7fa204aaf9b7ed2eefa168";

interface PurchasedGamesGraphqlResponse {
  data?: {
    purchasedTitlesRetrieve?: {
      games: PurchasedGame[];
      pageInfo?: PurchasedGamesPageInfo | null;
    } | null;
  } | null;
  errors?: Array<{ message?: string }>;
}

/**
 * Typed wrappers around the PSN mobile and web API endpoints.
 *
 * User-scoped endpoints accept the literal string "me" (the authenticated
 * account) or a numeric account id. Use {@link resolveAccountId} to turn an
 * online id (PSN username) into an account id first.
 */
export class PsnApi {
  constructor(private readonly http: PsnHttpClient) {}

  // ---- Users -------------------------------------------------------------

  getProfile(accountId: string): Promise<UserProfile> {
    return this.http.request<UserProfile>(
      `/userProfile/v1/internal/users/${encodeURIComponent(accountId)}/profiles`,
    );
  }

  searchPlayers(
    searchTerm: string,
    limit = 20,
  ): Promise<UniversalSearchResponse> {
    return this.http.request<UniversalSearchResponse>(
      "/search/v1/universalSearch",
      {
        method: "POST",
        body: {
          searchTerm,
          domainRequests: [
            {
              domain: "SocialAllAccounts",
              pagination: { cursor: "", pageSize: limit },
            },
          ],
        },
      },
    );
  }

  /**
   * Resolves a user reference to an account id. Accepts "me", a numeric
   * account id (passed through), or an online id which is looked up via
   * universal search and matched exactly (case-insensitively).
   */
  async resolveAccountId(user: string): Promise<string> {
    const trimmed = user.trim();
    if (trimmed === "me" || /^\d+$/.test(trimmed)) return trimmed;

    const search = await this.searchPlayers(trimmed, 20);
    const results = search.domainResponses[0]?.results ?? [];
    const match = results.find(
      (r) =>
        r.socialMetadata?.onlineId?.toLowerCase() === trimmed.toLowerCase(),
    );
    if (!match?.socialMetadata?.accountId) {
      throw new Error(
        `No PSN user found with online id "${trimmed}". ` +
          "Try psn_search_players to find the exact online id.",
      );
    }
    return match.socialMetadata.accountId;
  }

  getFriends(
    accountId: string,
    limit = 100,
    offset = 0,
  ): Promise<FriendsResponse> {
    return this.http.request<FriendsResponse>(
      `/userProfile/v1/internal/users/${encodeURIComponent(accountId)}/friends`,
      { query: { limit, offset } },
    );
  }

  getBasicPresence(
    accountId: string,
  ): Promise<{ basicPresence: BasicPresence }> {
    return this.http.request<{ basicPresence: BasicPresence }>(
      `/userProfile/v1/internal/users/${encodeURIComponent(accountId)}/basicPresences`,
      { query: { type: "primary" } },
    );
  }

  getBasicPresences(
    accountIds: string[],
  ): Promise<{ basicPresences: BasicPresence[] }> {
    return this.http.request<{ basicPresences: BasicPresence[] }>(
      "/userProfile/v1/internal/users/basicPresences",
      { query: { type: "primary", accountIds: accountIds.join(",") } },
    );
  }

  // ---- Trophies ----------------------------------------------------------

  getTrophySummary(accountId: string): Promise<TrophySummary> {
    return this.http.request<TrophySummary>(
      `/trophy/v1/users/${encodeURIComponent(accountId)}/trophySummary`,
    );
  }

  getTrophyTitles(
    accountId: string,
    limit = 100,
    offset = 0,
  ): Promise<TrophyTitlesResponse> {
    return this.http.request<TrophyTitlesResponse>(
      `/trophy/v1/users/${encodeURIComponent(accountId)}/trophyTitles`,
      { query: { limit, offset } },
    );
  }

  /** Trophy definitions for a title (names, descriptions, types). */
  getTitleTrophies(
    npCommunicationId: string,
    npServiceName: NpServiceName,
    trophyGroupId = "all",
    limit = 200,
    offset = 0,
  ): Promise<TrophiesResponse> {
    return this.http.request<TrophiesResponse>(
      `/trophy/v1/npCommunicationIds/${encodeURIComponent(npCommunicationId)}` +
        `/trophyGroups/${encodeURIComponent(trophyGroupId)}/trophies`,
      { query: { npServiceName, limit, offset } },
    );
  }

  /** A user's earned/unearned status for each trophy in a title. */
  getEarnedTrophies(
    accountId: string,
    npCommunicationId: string,
    npServiceName: NpServiceName,
    trophyGroupId = "all",
    limit = 200,
    offset = 0,
  ): Promise<TrophiesResponse> {
    return this.http.request<TrophiesResponse>(
      `/trophy/v1/users/${encodeURIComponent(accountId)}` +
        `/npCommunicationIds/${encodeURIComponent(npCommunicationId)}` +
        `/trophyGroups/${encodeURIComponent(trophyGroupId)}/trophies`,
      { query: { npServiceName, limit, offset } },
    );
  }

  // ---- Game library ------------------------------------------------------

  /** Digital purchases for the authenticated account, including unplayed games. */
  async getPurchasedGames(
    options: PurchasedGamesOptions = {},
  ): Promise<PurchasedGamesResponse> {
    const result =
      options.membership === "NONE"
        ? await this.getPurchasedGamesWithoutPsPlus(options)
        : await this.getPurchasedGamesPage(options);
    if ((options.includePlayTime ?? true) && result.games.length > 0) {
      try {
        result.games = await this.addPlayTime(result.games);
      } catch (error) {
        result.playTimeError =
          "Play time unavailable: " +
          (error instanceof Error ? error.message : String(error));
      }
    }
    return result;
  }

  /** Fetch one raw library page without play-history enrichment. */
  private async getPurchasedGamesPage(
    options: PurchasedGamesOptions,
  ): Promise<PurchasedGamesResponse> {
    const {
      limit = 50,
      offset = 0,
      platform = ["ps4", "ps5"],
      isActive = true,
      membership,
      sortDirection = "desc",
    } = options;
    const response = await this.http.request<PurchasedGamesGraphqlResponse>(
      "/graphql/v1/op",
      {
        api: "web",
        // Apollo's CSRF protection also requires a header on bodyless GETs.
        headers: { "apollo-require-preflight": "true" },
        query: {
          operationName: "getPurchasedGameList",
          variables: JSON.stringify({
            isActive,
            platform,
            size: limit,
            start: offset,
            sortBy: "ACTIVE_DATE",
            sortDirection,
            membership,
          }),
          extensions: JSON.stringify({
            persistedQuery: {
              version: 1,
              sha256Hash: PURCHASED_GAMES_QUERY_HASH,
            },
          }),
        },
      },
    );

    // GraphQL can report failures (including expired query hashes) with HTTP 200.
    if (response?.errors?.length) {
      const details = response.errors
        .map((error) => error.message)
        .filter(Boolean)
        .join("; ");
      throw new Error(
        `PSN purchased games query failed: ${details || "Unknown GraphQL error"}`,
      );
    }
    const library = response?.data?.purchasedTitlesRetrieve;
    if (!library || !Array.isArray(library.games)) {
      throw new Error("PSN purchased games query returned no valid game list.");
    }

    const { games } = library;
    const pageInfo = library.pageInfo ?? undefined;
    const hasMore = pageInfo ? !pageInfo.isLast : games.length === limit;
    const nextOffset = pageInfo
      ? pageInfo.offset + pageInfo.size
      : offset + games.length;
    return {
      games,
      ...(pageInfo ? { pageInfo, totalItemCount: pageInfo.totalCount } : {}),
      ...(hasMore && games.length > 0 && nextOffset > offset
        ? { nextOffset }
        : {}),
    };
  }

  /** Sony accepts NONE but returns an empty library, so filter raw pages here. */
  private async getPurchasedGamesWithoutPsPlus(
    options: PurchasedGamesOptions,
  ): Promise<PurchasedGamesResponse> {
    const { limit = 50, offset = 0 } = options;
    const rawPageSize = 100;
    const games: PurchasedGame[] = [];
    let matchedCount = 0;
    let rawOffset = 0;

    while (true) {
      const page = await this.getPurchasedGamesPage({
        ...options,
        membership: undefined,
        limit: rawPageSize,
        offset: rawOffset,
      });
      const info = page.pageInfo;
      if (
        info &&
        (typeof info.isLast !== "boolean" ||
          info.offset !== rawOffset ||
          !Number.isSafeInteger(info.size) ||
          info.size < 0 ||
          !Number.isSafeInteger(info.totalCount) ||
          info.totalCount < 0 ||
          (!info.isLast && (info.size === 0 || page.games.length === 0)))
      ) {
        throw new Error("PSN purchased games returned invalid pagination.");
      }

      for (const game of page.games) {
        if (game?.membership !== "NONE") continue;
        if (matchedCount >= offset && games.length < limit) games.push(game);
        matchedCount++;
      }

      const exhausted = info ? info.isLast : page.games.length < rawPageSize;
      const hasMore = matchedCount > offset + games.length;
      // Look ahead for an actual matching entitlement before exposing nextOffset.
      // Only a completed scan can supply the exact filtered total and pageInfo.
      if (exhausted || hasMore) {
        return {
          games,
          ...(hasMore ? { nextOffset: offset + games.length } : {}),
          ...(exhausted
            ? {
                totalItemCount: matchedCount,
                pageInfo: {
                  offset,
                  size: limit,
                  totalCount: matchedCount,
                  isLast: !hasMore,
                },
              }
            : {}),
        };
      }

      const nextOffset = page.nextOffset;
      if (
        nextOffset === undefined ||
        !Number.isSafeInteger(nextOffset) ||
        nextOffset <= rawOffset ||
        (info && nextOffset >= info.totalCount)
      ) {
        throw new Error("PSN purchased games returned invalid pagination.");
      }
      rawOffset = nextOffset;
    }
  }

  /** Scan play history until every purchased title is matched or history ends. */
  private async addPlayTime(games: PurchasedGame[]): Promise<PurchasedGame[]> {
    const remaining = new Set(games.map((game) => game.titleId));
    const matches = new Map<string, PlayedGame>();
    let offset = 0;
    while (remaining.size > 0) {
      const page = await this.getPlayedGames("me", 200, offset);
      if (
        !Array.isArray(page?.titles) ||
        !Number.isInteger(page.totalItemCount) ||
        page.totalItemCount < 0
      ) {
        throw new Error("PSN play history returned no valid game list.");
      }
      for (const title of page.titles) {
        // Exact IDs keep different platforms and editions separate.
        if (remaining.delete(title.titleId)) matches.set(title.titleId, title);
      }
      if (remaining.size === 0 || page.titles.length === 0) break;

      const nextOffset = page.nextOffset ?? offset + page.titles.length;
      if (nextOffset >= page.totalItemCount) break;
      if (!Number.isInteger(nextOffset) || nextOffset <= offset) {
        throw new Error("PSN play history returned invalid pagination.");
      }
      offset = nextOffset;
    }
    return games.map((game) => {
      const played = matches.get(game.titleId);
      if (!played) return game;
      return {
        ...game,
        playDuration: played.playDuration,
        playCount: played.playCount,
        firstPlayedDateTime: played.firstPlayedDateTime,
        lastPlayedDateTime: played.lastPlayedDateTime,
      };
    });
  }

  getPlayedGames(
    accountId: string,
    limit = 50,
    offset = 0,
  ): Promise<PlayedGamesResponse> {
    return this.http.request<PlayedGamesResponse>(
      `/gamelist/v2/users/${encodeURIComponent(accountId)}/titles`,
      {
        query: {
          categories: "ps4_game,ps5_native_game,pspc_game",
          limit,
          offset,
        },
      },
    );
  }
}
