import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  authenticateWithNpsso,
  PsnAuthError,
  TokenManager,
} from "../src/psn/auth.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(responses: Response[]): void {
  const queue = [...responses];
  globalThis.fetch = async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra fetch call");
    return next;
  };
}

test("TokenManager rejects an empty NPSSO token", () => {
  assert.throws(() => new TokenManager(""), PsnAuthError);
});

test("authenticateWithNpsso exchanges NPSSO for a token set", async () => {
  stubFetch([
    new Response(null, {
      status: 302,
      headers: {
        location: "com.scee.psxandroid.scecompcall://redirect?code=v3.abc123",
      },
    }),
    Response.json({
      access_token: "access-1",
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "refresh-1",
      refresh_token_expires_in: 5184000,
      scope: "psn:mobile.v2.core psn:clientapp",
    }),
  ]);

  const before = Date.now();
  const tokens = await authenticateWithNpsso("npsso-token");
  assert.equal(tokens.accessToken, "access-1");
  assert.equal(tokens.refreshToken, "refresh-1");
  assert.ok(tokens.expiresAt >= before + 3600_000);
  assert.ok(tokens.refreshExpiresAt > tokens.expiresAt);
});

test("authenticateWithNpsso fails clearly on an expired NPSSO token", async () => {
  stubFetch([
    new Response(null, {
      status: 302,
      headers: { location: "https://example.com/error" },
    }),
  ]);
  await assert.rejects(authenticateWithNpsso("stale"), PsnAuthError);
});

test("TokenManager caches the access token until it nears expiry", async () => {
  let authCalls = 0;
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/authorize")) {
      authCalls++;
      return new Response(null, {
        status: 302,
        headers: {
          location: "com.scee.psxandroid.scecompcall://redirect?code=v3.xyz",
        },
      });
    }
    return Response.json({
      access_token: `access-${authCalls}`,
      token_type: "bearer",
      expires_in: 3600,
      refresh_token: "refresh",
      refresh_token_expires_in: 5184000,
      scope: "psn:mobile.v2.core psn:clientapp",
    });
  };

  const manager = new TokenManager("npsso");
  assert.equal(await manager.getAccessToken(), "access-1");
  assert.equal(await manager.getAccessToken(), "access-1");
  assert.equal(authCalls, 1);
});
