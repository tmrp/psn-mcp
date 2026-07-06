import { PsnHttpClient } from "./http.js";
import type {
  BasicPresence,
  FriendsResponse,
  PlayedGamesResponse,
  TrophiesResponse,
  TrophySummary,
  TrophyTitlesResponse,
  UniversalSearchResponse,
  UserProfile,
} from "./types.js";

export type NpServiceName = "trophy" | "trophy2";

/**
 * Typed wrappers around the PSN mobile API endpoints.
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
      `/userProfile/v1/internal/users/${encodeURIComponent(accountId)}/profiles`
    );
  }

  searchPlayers(searchTerm: string, limit = 20): Promise<UniversalSearchResponse> {
    return this.http.request<UniversalSearchResponse>("/search/v1/universalSearch", {
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
    });
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
      (r) => r.socialMetadata?.onlineId?.toLowerCase() === trimmed.toLowerCase()
    );
    if (!match?.socialMetadata?.accountId) {
      throw new Error(
        `No PSN user found with online id "${trimmed}". ` +
          "Try psn_search_players to find the exact online id."
      );
    }
    return match.socialMetadata.accountId;
  }

  getFriends(accountId: string, limit = 100, offset = 0): Promise<FriendsResponse> {
    return this.http.request<FriendsResponse>(
      `/userProfile/v1/internal/users/${encodeURIComponent(accountId)}/friends`,
      { query: { limit, offset } }
    );
  }

  getBasicPresence(accountId: string): Promise<{ basicPresence: BasicPresence }> {
    return this.http.request<{ basicPresence: BasicPresence }>(
      `/userProfile/v1/internal/users/${encodeURIComponent(accountId)}/basicPresences`,
      { query: { type: "primary" } }
    );
  }

  getBasicPresences(accountIds: string[]): Promise<{ basicPresences: BasicPresence[] }> {
    return this.http.request<{ basicPresences: BasicPresence[] }>(
      "/userProfile/v1/internal/users/basicPresences",
      { query: { type: "primary", accountIds: accountIds.join(",") } }
    );
  }

  // ---- Trophies ----------------------------------------------------------

  getTrophySummary(accountId: string): Promise<TrophySummary> {
    return this.http.request<TrophySummary>(
      `/trophy/v1/users/${encodeURIComponent(accountId)}/trophySummary`
    );
  }

  getTrophyTitles(accountId: string, limit = 100, offset = 0): Promise<TrophyTitlesResponse> {
    return this.http.request<TrophyTitlesResponse>(
      `/trophy/v1/users/${encodeURIComponent(accountId)}/trophyTitles`,
      { query: { limit, offset } }
    );
  }

  /** Trophy definitions for a title (names, descriptions, types). */
  getTitleTrophies(
    npCommunicationId: string,
    npServiceName: NpServiceName,
    trophyGroupId = "all",
    limit = 200,
    offset = 0
  ): Promise<TrophiesResponse> {
    return this.http.request<TrophiesResponse>(
      `/trophy/v1/npCommunicationIds/${encodeURIComponent(npCommunicationId)}` +
        `/trophyGroups/${encodeURIComponent(trophyGroupId)}/trophies`,
      { query: { npServiceName, limit, offset } }
    );
  }

  /** A user's earned/unearned status for each trophy in a title. */
  getEarnedTrophies(
    accountId: string,
    npCommunicationId: string,
    npServiceName: NpServiceName,
    trophyGroupId = "all",
    limit = 200,
    offset = 0
  ): Promise<TrophiesResponse> {
    return this.http.request<TrophiesResponse>(
      `/trophy/v1/users/${encodeURIComponent(accountId)}` +
        `/npCommunicationIds/${encodeURIComponent(npCommunicationId)}` +
        `/trophyGroups/${encodeURIComponent(trophyGroupId)}/trophies`,
      { query: { npServiceName, limit, offset } }
    );
  }

  // ---- Game library ------------------------------------------------------

  getPlayedGames(accountId: string, limit = 50, offset = 0): Promise<PlayedGamesResponse> {
    return this.http.request<PlayedGamesResponse>(
      `/gamelist/v2/users/${encodeURIComponent(accountId)}/titles`,
      {
        query: {
          categories: "ps4_game,ps5_native_game,pspc_game",
          limit,
          offset,
        },
      }
    );
  }
}
