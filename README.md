# psn-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for
interfacing with the PlayStation Network. Lets MCP clients like Claude look up
PSN profiles, friends, online presence, trophies, and play history.

The PSN API layer is written from scratch in TypeScript on Node's built-in
`fetch` — no PSN client dependencies. It authenticates the same way the official
PlayStation mobile app does and talks directly to Sony's `m.np.playstation.com`
API.

## Requirements

- Node.js 24.18+
- A PlayStation Network account

## Signing in

The MCP server can automate NPSSO capture through an isolated browser profile:

1. Start the MCP server without `PSN_NPSSO`.
2. Call the `psn_begin_login` tool.
3. Sign in to PlayStation in the browser window it opens.
4. Call the `psn_complete_login` tool.

`psn_complete_login` reads the PlayStation `npsso` browser cookie, verifies it,
and stores it in `~/.config/psn-mcp/credentials.json` with owner-only file
permissions. Future server starts use the stored token automatically. Set
`PSN_NPSSO_FILE` to choose a different credential file.

If browser automation is unavailable, you can still configure an NPSSO manually:

1. Sign in at [playstation.com](https://www.playstation.com).
2. In the same browser, open <https://ca.account.sony.com/api/v1/ssocookie>.
3. Copy the 64-character `npsso` value from the JSON response into `PSN_NPSSO`.

The server exchanges the NPSSO for an OAuth access token on first use and
refreshes it automatically. NPSSO tokens expire after about two months; when
tools start failing with an auth error, run the login flow again.

> **Note:** this uses your personal account session. What you can see (other
> users' friends, presence, play history) is governed by normal PSN privacy
> settings.

## Usage with an MCP client

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

## Tools

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
| `psn_get_store_deals`     | Games on sale, with prices, discounts, and (optional) star ratings |
| `psn_get_store_product`   | Store product details: price, discount, and community star rating  |
| `psn_search_store`        | Search the store catalog by name, with current prices              |

Every user-scoped tool accepts `"me"` (the authenticated account), a PSN online
id (username), or a numeric account id — online ids are resolved automatically.

For PS5 titles pass `npServiceName: "trophy2"`; for PS4 and earlier use
`"trophy"`. `psn_get_trophy_titles` reports the right value per game.

The three `store` tools browse the public PlayStation Store and need **no PSN
account**. They power prompts like _"give me the top 10 games currently on sale
based on review score"_ — call `psn_get_store_deals` with `includeRatings: true`
and rank by `starRating.averageRating`. Set `PSN_STORE_LOCALE` (e.g. `en-gb`,
`de-de`, `ja-jp`) to change the store region and currency; the default is
`en-us`.

## Architecture

```
src/
  index.ts        Entry point: stdio MCP server wiring
  tools.ts        MCP tool definitions (zod schemas -> PSN API calls)
  psn/
    auth.ts       NPSSO -> OAuth code -> access token exchange, auto-refresh
    http.ts       Authenticated JSON client for m.np.playstation.com
    api.ts        Typed endpoint wrappers (profiles, trophies, games, search)
    store.ts      Public store catalog: deals, search, prices, star ratings
    types.ts      PSN API response types
```

The store module works differently from the account API: the store's GraphQL
endpoint only accepts Sony's whitelisted persisted queries, so it instead reads
the Apollo state and star-rating payloads that the store server-renders into
every page's `__NEXT_DATA__` blob. This needs no authentication but is
inherently coupled to the store's page structure.

Authentication is lazy: the server starts and lists tools without credentials;
the token exchange happens on the first tool call. Access tokens are refreshed
ahead of expiry, falling back to a full NPSSO re-exchange if the refresh token
has expired.

## Disclaimer

This project uses undocumented PSN endpoints and is not affiliated with or
endorsed by Sony Interactive Entertainment. Use at your own risk.
