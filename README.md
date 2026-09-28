<div align="center">

# 🎮 psn-mcp

**A [Model Context Protocol](https://modelcontextprotocol.io) server for the PlayStation Network**

Let MCP clients like Claude look up PSN profiles, friends, online presence,
trophies, purchased games, play history, and store deals — in plain language.

<br />

[![npm version](https://img.shields.io/npm/v/psn-mcp?color=0070d1&label=npm)](https://www.npmjs.com/package/psn-mcp)
[![npm downloads](https://img.shields.io/npm/dm/psn-mcp?color=0070d1)](https://www.npmjs.com/package/psn-mcp)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A524.18-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-000000)](https://modelcontextprotocol.io)

</div>

---

The PSN API layer is written from scratch in TypeScript on Node's built-in
`fetch` — no PSN client dependencies. It authenticates the same way the official
PlayStation mobile app does and talks directly to Sony's mobile and web APIs.

## ✨ Highlights

- 🧑‍🤝‍🧑 **Profiles & friends** — look up any player, resolve friends lists to full profiles
- 🟢 **Live presence** — see who's online, on which platform, and what they're playing
- 🏆 **Trophies** — levels, tiers, per-game progress, earned state, and global rarity
- ⏱️ **Play history** — PS4/PS5 games with play counts and total durations
- 🎮 **Purchased library** — digital PS4/PS5 games, including unplayed titles, with artwork and license metadata
- 🛒 **Store** — deals, prices, discounts, and review scores, **no PSN account required**
- 🔒 **Zero client deps** — pure TypeScript on Node `fetch`, credentials stored owner-only

## 📦 Requirements

- Node.js 24.18+
- A PlayStation Network account (not needed for the store tools)

## 🚀 Usage with an MCP client

No installation needed — run it with `npx`. Add to your client's MCP
configuration (e.g. `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "psn": {
      "command": "npx",
      "args": ["-y", "psn-mcp"]
    }
  }
}
```

Or for Claude Code:

```sh
claude mcp add psn -- npx -y psn-mcp
```

## 🔑 Signing in

The MCP server can automate NPSSO capture through an isolated browser profile:

1. Start the MCP server without `PSN_NPSSO`.
2. Call the `psn_begin_login` tool.
3. Sign in to PlayStation in the browser window it opens.
4. Call the `psn_complete_login` tool.

`psn_complete_login` reads the PlayStation `npsso` browser cookie, verifies it,
and stores it in `~/.config/psn-mcp/credentials.json` with owner-only file
permissions. Future server starts use the stored token automatically. Set
`PSN_NPSSO_FILE` to choose a different credential file.

<details>
<summary><strong>Manual NPSSO setup</strong> (if browser automation is unavailable)</summary>

<br />

1. Sign in at [playstation.com](https://www.playstation.com).
2. In the same browser, open <https://ca.account.sony.com/api/v1/ssocookie>.
3. Copy the 64-character `npsso` value from the JSON response into `PSN_NPSSO`.

</details>

The server exchanges the NPSSO for an OAuth access token on first use and
refreshes it automatically. NPSSO tokens expire after about two months; when
tools start failing with an auth error, run the login flow again.

> [!NOTE]
> This uses your personal account session. What you can see (other users'
> friends, presence, play history) is governed by normal PSN privacy settings.

## 🧰 Tools

| Tool                      | Description                                                        |
| ------------------------- | ------------------------------------------------------------------ |
| `psn_auth_status`         | Whether PSN credentials are configured or login is in progress     |
| `psn_begin_login`         | Open the browser-based PSN login helper                            |
| `psn_complete_login`      | Capture and save the NPSSO token from the login helper             |
| `psn_cancel_login`        | Close the login helper without saving credentials                  |
| `psn_get_profile`         | Profile for a user: online id, about-me, avatars, PS Plus status   |
| `psn_search_players`      | Search PSN players by name; returns online ids and account ids     |
| `psn_get_friends`         | A user's friends list, resolved to profiles                        |
| `psn_get_presence`        | Online status, current platform, and the game being played         |
| `psn_get_trophy_summary`  | Trophy level, tier, and total trophy counts                        |
| `psn_get_trophy_titles`   | Games with trophy progress, most recently played first             |
| `psn_get_title_trophies`  | Full trophy list defined for a game (names, types, groups)         |
| `psn_get_earned_trophies` | Which trophies a user earned in a game, with timestamps and rarity |
| `psn_get_played_games`    | Played PS4/PS5 games with play counts and durations                |
| `psn_get_purchased_games` | Your digital PS4/PS5 library with artwork and entitlement metadata |
| `psn_get_store_deals`     | Games on sale, with prices, discounts, and (optional) star ratings |
| `psn_get_store_product`   | Store product details: price, discount, and community star rating  |
| `psn_search_store`        | Search the store catalog by name, with current prices              |

Every user-scoped tool accepts `"me"` (the authenticated account), a PSN online
id (username), or a numeric account id — online ids are resolved automatically.

`psn_get_purchased_games` accesses only the authenticated account and has no
`user` parameter. It returns digital library entitlements, including unplayed
games and potentially free or PS Plus titles, rather than a payment history or
physical-disc collection. Metadata includes names, platforms, artwork, product,
title and entitlement ids, and available active/downloadable/pre-order flags
and membership information. It does not report purchase prices or dates.

Purchased games default to active PS4/PS5 licenses, ordered by activation date
(newest first). Use `platform: ["ps5"]` to filter platforms, `isActive: false`
for inactive licenses, or `membership: "NONE"` / `"PS_PLUS"` to filter membership.
Omit `membership` to include both. Use `sortDirection: "asc"` for oldest first.
Pages accept `limit` (1–100, default 50) and `offset` (default 0). Pass the
returned `nextOffset` as `offset` until it is absent. When Sony omits its
`pageInfo`, a full final page can be followed by an empty page; total counts
are only returned when Sony supplies them.

Play time is included by default: `playDuration` (an ISO 8601 duration such as
`PT12H30M`), `playCount`, `firstPlayedDateTime`, and `lastPlayedDateTime` where
PSN provides them. This may require several play-history requests per
purchased-library page; set `includePlayTime: false` to skip them. Games are
matched by exact title ID, keeping PS4/PS5 versions separate. Missing fields mean no matching
data was available, not zero time played. If the lookup fails, the library
still returns with a `playTimeError` explaining why play time is unavailable.

For PS5 titles pass `npServiceName: "trophy2"`; for PS4 and earlier use
`"trophy"`. `psn_get_trophy_titles` reports the right value per game.

The three `store` tools browse the public PlayStation Store and need **no PSN
account**. Set `PSN_STORE_LOCALE` (e.g. `en-gb`, `de-de`, `ja-jp`) to change the
store region and currency; the default is `en-us`.

## 💬 Examples

Once the server is connected, just ask in natural language. Some prompts and the
tools they exercise:

#### 🟢 Presence and friends

> _"Is anyone on my friends list online right now? What are they playing?"_

Calls `psn_get_friends`, then `psn_get_presence` for each friend, and reports
who is online, on which platform, and in what game.

> _"Look up the profile for online id `Hakoom`."_

Calls `psn_get_profile` with `user: "Hakoom"` — any tool that takes a `user`
accepts `"me"`, an online id, or a numeric account id.

#### 🏆 Trophies

> _"What's my trophy level, and what game did I most recently earn trophies
> in?"_

Calls `psn_get_trophy_summary` and `psn_get_trophy_titles` (most recently played
first).

> _"Which trophies am I still missing in Astro Bot, and how rare are they?"_

Finds the game via `psn_get_trophy_titles` (getting its `npCommunicationId` and
`npServiceName`), then combines `psn_get_title_trophies` (names and
descriptions) with `psn_get_earned_trophies` (earned state and global rarity) to
list the unearned ones, rarest first.

#### ⏱️ Play history

> _"How many hours have I put into my ten most-played PS5 games?"_

Calls `psn_get_played_games` and ranks by total play duration.

#### 🎮 Purchased games

> _"List the PS5 games in my digital library, including games I haven't played."_

Calls `psn_get_purchased_games` with `platform: ["ps5"]`, following `nextOffset`
to retrieve more pages. Each entry includes its available game and license
metadata. Use its `productId` with `psn_get_store_product` for current store
prices and ratings (these are not the original purchase price).

> _"List my purchased games with the time I've spent playing each one."_

Calls `psn_get_purchased_games`, which includes play time by default.

#### 🛒 Store (no PSN account needed)

> _"Give me the top 10 games currently on sale based on review score."_

Calls `psn_get_store_deals` with `includeRatings: true` and ranks by
`starRating.averageRating`.

> _"Is Elden Ring discounted right now? What do reviewers rate it?"_

Calls `psn_search_store` with `query: "Elden Ring"`, then
`psn_get_store_product` for the price, discount, and star-rating breakdown.

## 🏗️ Architecture

```
src/
  index.ts        Entry point: stdio MCP server wiring
  server.ts       MCP server factory and protocol-version settings
  tools.ts        MCP tool definitions (zod schemas -> PSN API calls)
  psn/
    auth.ts       NPSSO -> OAuth code -> access token exchange, auto-refresh
    http.ts       Authenticated JSON client for Sony's mobile and web APIs
    api.ts        Typed endpoint wrappers (profiles, trophies, game libraries, search)
    store.ts      Public store catalog: deals, search, prices, star ratings
    types.ts      PSN API response types
```

The store module works differently from the account API: the store's GraphQL
endpoint only accepts Sony's whitelisted persisted queries, so it instead reads
the Apollo state and star-rating payloads that the store server-renders into
every page's `__NEXT_DATA__` blob. This needs no authentication but is
inherently coupled to the store's page structure.

The purchased library uses the authenticated web GraphQL API's persisted
`getPurchasedGameList` query. Like the other undocumented endpoints, its query
hash and response shape may change; GraphQL failures are returned as tool errors.

Authentication is lazy: the server starts and lists tools without credentials;
the token exchange happens on the first tool call. Access tokens are refreshed
ahead of expiry, falling back to a full NPSSO re-exchange if the refresh token
has expired.

## ⚠️ Disclaimer

This project uses undocumented PSN endpoints and is not affiliated with or
endorsed by Sony Interactive Entertainment. Use at your own risk.

<div align="center">
<br />
<sub>Licensed under <a href="./LICENSE">MIT</a></sub>
</div>
