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

test("request surfaces GraphQL error messages on HTTP failures", async () => {
  const body = {
    errors: [
      {
        message:
          "This operation has been blocked as a potential Cross-Site Request Forgery (CSRF).",
        extensions: {},
      },
      { message: "Provide a non-empty apollo-require-preflight header." },
    ],
  };
  globalThis.fetch = async () => Response.json(body, { status: 400 });

  const client = new PsnHttpClient(tokens);
  await assert.rejects(
    client.request("/graphql/v1/op", { api: "web" }),
    (error) => {
      assert.ok(error instanceof PsnApiError);
      assert.equal(error.status, 400);
      assert.deepEqual(error.body, body);
      for (const { message } of body.errors) {
        assert.ok(error.message.includes(message));
      }
      return true;
    },
  );
});

test("request ignores malformed GraphQL errors and retains valid messages", async () => {
  globalThis.fetch = async () =>
    Response.json(
      {
        errors: [
          null,
          {},
          { message: 123 },
          { message: "" },
          { message: "CSRF" },
        ],
      },
      { status: 400 },
    );
  const client = new PsnHttpClient(tokens);
  await assert.rejects(client.request("/graphql/v1/op", { api: "web" }), {
    name: "PsnApiError",
    message: "PSN API request to /graphql/v1/op failed with HTTP 400: CSRF",
  });
});

test("request retains the HTTP error when no usable error message is present", async () => {
  const client = new PsnHttpClient(tokens);
  for (const body of [null, {}, { errors: [] }, { errors: "invalid" }]) {
    globalThis.fetch = async () => Response.json(body, { status: 400 });
    await assert.rejects(client.request("/graphql/v1/op", { api: "web" }), {
      name: "PsnApiError",
      message: "PSN API request to /graphql/v1/op failed with HTTP 400",
    });
  }
});

test("request uses GraphQL errors when the REST error message is malformed", async () => {
  const client = new PsnHttpClient(tokens);
  for (const message of [{ unexpected: "object" }, 123, true, "   "]) {
    globalThis.fetch = async () =>
      Response.json(
        { error: { message }, errors: [{ message: "CSRF" }] },
        { status: 400 },
      );
    await assert.rejects(client.request("/graphql/v1/op", { api: "web" }), {
      name: "PsnApiError",
      message: "PSN API request to /graphql/v1/op failed with HTTP 400: CSRF",
    });
  }
});
