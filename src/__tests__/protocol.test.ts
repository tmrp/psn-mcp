import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type JSONRPCMessage,
  type RequestId,
  type Transport,
} from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { PsnApi } from "../psn/api.js";
import { TokenManager } from "../psn/auth.js";
import { PsnStore } from "../psn/store.js";
import { createPsnMcpServer } from "../server.js";

const EXPECTED_TOOLS = [
  "psn_auth_status",
  "psn_begin_login",
  "psn_complete_login",
  "psn_cancel_login",
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

type ResponseResolver = (message: JSONRPCMessage) => void;

class TestTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  readonly started: Promise<void>;
  private markStarted!: () => void;
  private readonly responses = new Map<RequestId, ResponseResolver>();

  constructor() {
    this.started = new Promise((resolve) => {
      this.markStarted = resolve;
    });
  }

  async start(): Promise<void> {
    this.markStarted();
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = "id" in message ? message.id : undefined;
    if ("method" in message || id === null || id === undefined) {
      return;
    }
    this.responses.get(id)?.(message);
  }

  request(message: JSONRPCMessage): Promise<JSONRPCMessage> {
    const id = "id" in message ? message.id : undefined;
    assert.ok(id !== null && id !== undefined);
    assert.ok(this.onmessage, "transport has not been started");

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`timed out waiting for response ${id}`)),
        1_000,
      );
      this.responses.set(id, (response) => {
        clearTimeout(timeout);
        this.responses.delete(id);
        resolve(response);
      });
      this.onmessage?.(message);
    });
  }

  notify(message: JSONRPCMessage): void {
    assert.ok(this.onmessage, "transport has not been started");
    this.onmessage(message);
  }
}

function buildTestServer() {
  return createPsnMcpServer(
    "test-version",
    {} as PsnApi,
    new PsnStore(),
    new TokenManager(),
  );
}

function resultOf(message: JSONRPCMessage): Record<string, unknown> {
  assert.ok("result" in message, "expected a JSON-RPC result");
  return message.result as Record<string, unknown>;
}

function toolNames(result: Record<string, unknown>): string[] {
  return (result.tools as Array<{ name: string }>).map((tool) => tool.name);
}

test("stdio serves legacy clients and lists all tools", async () => {
  const transport = new TestTransport();
  const handle = serveStdio(() => buildTestServer(), { transport });

  try {
    await transport.started;
    const initialize = resultOf(
      await transport.request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "legacy-test", version: "1.0.0" },
        },
      }),
    );
    assert.equal(initialize.protocolVersion, "2025-11-25");

    transport.notify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const tools = resultOf(
      await transport.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    );

    assert.deepEqual(toolNames(tools), EXPECTED_TOOLS);
    assert.equal("ttlMs" in tools, false);
  } finally {
    await handle.close();
  }
});

test("stdio serves 2026-07-28 clients with cacheable discovery and tool lists", async () => {
  const transport = new TestTransport();
  const handle = serveStdio(() => buildTestServer(), { transport });
  const envelope = {
    [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
    [CLIENT_INFO_META_KEY]: { name: "modern-test", version: "1.0.0" },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };

  try {
    await transport.started;
    const discovery = resultOf(
      await transport.request({
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: { _meta: envelope },
      } as JSONRPCMessage),
    );
    assert.equal(discovery.ttlMs, 300_000);
    assert.equal(discovery.cacheScope, "public");

    const tools = resultOf(
      await transport.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: { _meta: envelope },
      } as JSONRPCMessage),
    );

    assert.deepEqual(toolNames(tools), EXPECTED_TOOLS);
    assert.equal(tools.ttlMs, 300_000);
    assert.equal(tools.cacheScope, "public");
  } finally {
    await handle.close();
  }
});
