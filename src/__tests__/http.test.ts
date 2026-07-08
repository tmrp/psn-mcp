import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { PsnApiError, PsnHttpClient } from "../psn/http.js";
import type { TokenManager } from "../psn/auth.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const tokens = {
  getAccessToken: async () => "test-token",
} as unknown as TokenManager;

test("request sends a bearer token and query parameters", async () => {
  let captured: { url: string; headers: Headers } | undefined;
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    captured = { url: String(input), headers: new Headers(init?.headers) };
    return Response.json({ ok: true });
  };

  const client = new PsnHttpClient(tokens);
  const result = await client.request<{ ok: boolean }>(
    "/trophy/v1/users/me/trophySummary",
    {
      query: { limit: 10, skipped: undefined },
    },
  );

  assert.deepEqual(result, { ok: true });
  assert.ok(captured);
  const url = new URL(captured.url);
  assert.equal(url.origin, "https://m.np.playstation.com");
  assert.equal(url.pathname, "/api/trophy/v1/users/me/trophySummary");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.has("skipped"), false);
  assert.equal(captured.headers.get("authorization"), "Bearer test-token");
});

test("request surfaces PSN error messages and privacy hints on 403", async () => {
  globalThis.fetch = async () =>
    Response.json({ error: { message: "Not permitted" } }, { status: 403 });

  const client = new PsnHttpClient(tokens);
  await assert.rejects(
    client.request("/userProfile/v1/internal/users/1/friends"),
    (error) => {
      assert.ok(error instanceof PsnApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /Not permitted/);
      assert.match(error.message, /private/);
      return true;
    },
  );
});

test("request tolerates empty response bodies", async () => {
  globalThis.fetch = async () => new Response("", { status: 200 });
  const client = new PsnHttpClient(tokens);
  assert.deepEqual(await client.request("/whatever"), {});
});
