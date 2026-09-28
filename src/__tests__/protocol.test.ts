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
  "psn_get_purchased_games",
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

function buildTestServer(psn = {} as PsnApi) {
  return createPsnMcpServer(
    "test-version",
    psn,
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

test("purchased-games tool applies defaults, validates inputs, and reports API errors", async () => {
  const calls: unknown[] = [];
  let fail = false;
  const library = {
    games: [
      { titleId: "PPSA00001_00", name: "Unplayed game", isPreOrder: true },
    ],
    nextOffset: 50,
  };
  const psn = {
    getPurchasedGames: async (options: unknown) => {
      calls.push(options);
      if (fail) throw new Error("PSN library unavailable");
      return library;
    },
  } as unknown as PsnApi;
  const transport = new TestTransport();
  const handle = serveStdio(() => buildTestServer(psn), { transport });
  let id = 0;
  const callTool = async (args: Record<string, unknown>) =>
    resultOf(
      await transport.request({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: {
          name: "psn_get_purchased_games",
          arguments: args,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: "2026-07-28",
            [CLIENT_INFO_META_KEY]: { name: "library-test", version: "1.0.0" },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      } as JSONRPCMessage),
    );

  try {
    await transport.started;
    const result = await callTool({});
    assert.deepEqual(calls, [
      {
        limit: 50,
        offset: 0,
        platform: ["ps4", "ps5"],
        isActive: true,
        sortDirection: "desc",
        includePlayTime: true,
      },
    ]);
    assert.deepEqual(
      JSON.parse((result.content as Array<{ text: string }>)[0].text),
      library,
    );

    const options = {
      limit: 10,
      offset: 20,
      platform: ["ps4"],
      isActive: false,
      membership: "NONE",
      sortDirection: "asc",
      includePlayTime: false,
    };
    await callTool(options);
    assert.deepEqual(calls[1], options);

    for (const invalid of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 0.5 },
      { platform: [] },
      { platform: ["ps3"] },
      { membership: "invalid" },
      { sortDirection: "invalid" },
      { isActive: "true" },
      { includePlayTime: "true" },
    ]) {
      const result = await callTool(invalid);
      assert.equal(result.isError, true);
    }
    assert.equal(calls.length, 2, "invalid input must not call PSN");

    fail = true;
    const error = await callTool({});
    assert.equal(error.isError, true);
    assert.match(
      (error.content as Array<{ text: string }>)[0].text,
      /PSN library unavailable/,
    );
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
