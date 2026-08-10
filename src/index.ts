#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { TokenManager } from "./psn/auth.js";
import { loadStoredNpsso } from "./psn/credentials.js";
import { PsnHttpClient } from "./psn/http.js";
import { PsnApi } from "./psn/api.js";
import { PsnStore } from "./psn/store.js";
import { createPsnMcpServer } from "./server.js";

// Read the version at runtime rather than hardcoding it. package.json sits one
// level up from this file in both dev (src/) and the published package (dist/),
// and is included in the package's `files` list.
const { version } = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "package.json"),
    "utf8",
  ),
) as { version: string };

async function main(): Promise<void> {
  const npsso = process.env.PSN_NPSSO || (await loadStoredNpsso()) || "";
  if (!npsso) {
    // stdout is reserved for the MCP protocol; diagnostics go to stderr.
    console.error(
      "warning: no PSN credentials are configured - account tools will fail until login completes.\n" +
        "Call the psn_begin_login MCP tool, sign in to PlayStation in the opened browser, " +
        "then call psn_complete_login.",
    );
  }

  // Auth is lazy: the token exchange happens on the first tool call, so the
  // server starts (and lists tools) even before credentials are configured.
  const tokens = new TokenManager(npsso);
  const psn = new PsnApi(new PsnHttpClient(tokens));
  // Store browsing is public web data; no PSN account needed.
  const store = new PsnStore(process.env.PSN_STORE_LOCALE ?? "en-us");

  // serveStdio selects the 2026-07-28 or legacy protocol era from the
  // connection's opening exchange and pins one server instance to it.
  serveStdio(() => createPsnMcpServer(version, psn, store, tokens), {
    onerror: (error) => console.error("mcp error:", error),
  });
  console.error("psn-mcp server running on stdio");
}

main().catch((error) => {
  console.error("fatal:", error);
  process.exit(1);
});
