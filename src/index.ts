#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TokenManager } from "./psn/auth.js";
import { PsnHttpClient } from "./psn/http.js";
import { PsnApi } from "./psn/api.js";
import { PsnStore } from "./psn/store.js";
import { registerTools } from "./tools.js";

async function main(): Promise<void> {
  const npsso = process.env.PSN_NPSSO ?? "";
  if (!npsso) {
    // stdout is reserved for the MCP protocol; diagnostics go to stderr.
    console.error(
      "warning: PSN_NPSSO is not set - tools will fail until it is configured.\n" +
        "Sign in at https://www.playstation.com, then copy the token from " +
        "https://ca.account.sony.com/api/v1/ssocookie"
    );
  }

  // Auth is lazy: the token exchange happens on the first tool call, so the
  // server starts (and lists tools) even before credentials are configured.
  const psn = new PsnApi(new PsnHttpClient(new TokenManager(npsso || "unset")));
  // Store browsing is public web data; no PSN account needed.
  const store = new PsnStore(process.env.PSN_STORE_LOCALE ?? "en-us");

  const server = new McpServer({ name: "psn-mcp", version: "0.1.0" });
  registerTools(server, psn, store);

  await server.connect(new StdioServerTransport());
  console.error("psn-mcp server running on stdio");
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
