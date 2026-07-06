# psn-mcp

An [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server for interfacing with the PlayStation Network. Lets MCP clients like Claude look up PSN profiles, friends, online presence, trophies, and play history.

The PSN API layer is written from scratch in TypeScript on Node's built-in `fetch` — no PSN client dependencies. It authenticates the same way the official PlayStation mobile app does and talks directly to Sony's `m.np.playstation.com` API.

## Requirements

- Node.js 18+
- A PlayStation Network account and its **NPSSO token** (see below)

## Getting your NPSSO token

1. Sign in at [playstation.com](https://www.playstation.com).
2. In the same browser, open <https://ca.account.sony.com/api/v1/ssocookie>.
3. Copy the 64-character `npsso` value from the JSON response.

The server exchanges the NPSSO for an OAuth access token on first use and refreshes it automatically. NPSSO tokens expire after about two months; when tools start failing with an auth error, fetch a fresh one.

> **Note:** this uses your personal account session. What you can see (other users' friends, presence, play history) is governed by normal PSN privacy settings.

## Installation

```sh
npm install
npm run build
```

## Usage with an MCP client

Add to your client's MCP configuration (e.g. `claude_desktop_config.json`, or `claude mcp add` for Claude Code):

```json
{
  "mcpServers": {
    "psn": {
      "command": "node",
      "args": ["/path/to/psn-mcp/dist/index.js"],
      "env": {
        "PSN_NPSSO": "<your npsso token>"
      }
    }
  }
}
```

Or run directly for development:

```sh
PSN_NPSSO=<token> npm run dev
```

## Tools

| Tool | Description |
| --- | --- |
| `psn_get_profile` | Profile for a user: online id, about-me, avatars, PS Plus status |
| `psn_search_players` | Search PSN players by name; returns online ids and account ids |
| `psn_get_friends` | A user's friends list, resolved to profiles |
| `psn_get_presence` | Online status, current platform, and the game being played |
| `psn_get_trophy_summary` | Trophy level, tier, and total trophy counts |
| `psn_get_trophy_titles` | Games with trophy progress, most recently played first |
| `psn_get_title_trophies` | Full trophy list defined for a game (names, types, groups) |
| `psn_get_earned_trophies` | Which trophies a user earned in a game, with timestamps and rarity |
| `psn_get_played_games` | Played PS4/PS5 games with play counts and durations |

Every user-scoped tool accepts `"me"` (the authenticated account), a PSN online id (username), or a numeric account id — online ids are resolved automatically.

For PS5 titles pass `npServiceName: "trophy2"`; for PS4 and earlier use `"trophy"`. `psn_get_trophy_titles` reports the right value per game.

## Architecture

```
src/
  index.ts        Entry point: stdio MCP server wiring
  tools.ts        MCP tool definitions (zod schemas -> PSN API calls)
  psn/
    auth.ts       NPSSO -> OAuth code -> access token exchange, auto-refresh
    http.ts       Authenticated JSON client for m.np.playstation.com
    api.ts        Typed endpoint wrappers (profiles, trophies, games, search)
    types.ts      PSN API response types
```

Authentication is lazy: the server starts and lists tools without credentials; the token exchange happens on the first tool call. Access tokens are refreshed ahead of expiry, falling back to a full NPSSO re-exchange if the refresh token has expired.

## Disclaimer

This project uses undocumented PSN endpoints and is not affiliated with or endorsed by Sony Interactive Entertainment. Use at your own risk.
