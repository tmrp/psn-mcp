/**
 * Runtime smoke test: boots the built server (dist/index.js) over stdio,
 * performs the MCP handshake, and verifies every expected tool is listed.
 * Fully offline - no PSN credentials or network access required.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const EXPECTED_TOOLS = [
  "psn_get_profile",
  "psn_search_players",
  "psn_get_friends",
  "psn_get_presence",
  "psn_get_trophy_summary",
  "psn_get_trophy_titles",
  "psn_get_title_trophies",
  "psn_get_earned_trophies",
  "psn_get_played_games",
  "psn_get_store_deals",
  "psn_get_store_product",
  "psn_search_store",
];

const entry = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "index.js",
);

const proc = spawn(process.execPath, [entry], {
  stdio: ["pipe", "pipe", "inherit"],
});

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  proc.kill();
  process.exit(1);
};

const timer = setTimeout(
  () => fail("timed out waiting for server responses"),
  15_000,
);

const replies = new Map();
let buffer = "";
proc.stdout.on("data", (data) => {
  buffer += data;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.set(message.id, message);
    onReply();
  }
});
proc.on("exit", (code) => {
  if (!done) fail(`server exited early with code ${code}`);
});

const send = (message) => proc.stdin.write(`${JSON.stringify(message)}\n`);

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "runtime-smoke", version: "0.0.0" },
  },
});

let listSent = false;
let done = false;
function onReply() {
  if (replies.has(1) && !listSent) {
    listSent = true;
    const serverInfo = replies.get(1).result?.serverInfo;
    if (serverInfo?.name !== "psn-mcp")
      fail(`unexpected server info: ${JSON.stringify(serverInfo)}`);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  }
  if (replies.has(2) && !done) {
    done = true;
    clearTimeout(timer);
    const tools = (replies.get(2).result?.tools ?? []).map((tool) => tool.name);
    const missing = EXPECTED_TOOLS.filter((name) => !tools.includes(name));
    if (missing.length > 0) fail(`missing tools: ${missing.join(", ")}`);
    console.log(
      `OK: server initialized and lists all ${EXPECTED_TOOLS.length} tools`,
    );
    proc.kill();
    process.exit(0);
  }
}
