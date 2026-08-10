import { McpServer } from "@modelcontextprotocol/server";
import type { TokenManager } from "./psn/auth.js";
import type { PsnApi } from "./psn/api.js";
import type { PsnStore } from "./psn/store.js";
import { registerTools } from "./tools.js";

/** Build a protocol server for one negotiated MCP connection. */
export function createPsnMcpServer(
  version: string,
  psn: PsnApi,
  store: PsnStore,
  tokens: TokenManager,
): McpServer {
  const server = new McpServer(
    { name: "psn-mcp", version },
    {
      // The catalog is fixed for a given package version and contains no
      // user-specific data, so modern clients may safely share a short cache.
      cacheHints: {
        "server/discover": { ttlMs: 300_000, cacheScope: "public" },
        "tools/list": { ttlMs: 300_000, cacheScope: "public" },
      },
    },
  );
  registerTools(server, psn, store, tokens);
  return server;
}
