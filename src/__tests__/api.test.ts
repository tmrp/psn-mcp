import { test } from "node:test";
import assert from "node:assert/strict";
import { PsnApi } from "../psn/api.js";
import type { PsnHttpClient } from "../psn/http.js";

function apiWithStub(
  handler: (path: string, options?: unknown) => unknown,
): PsnApi {
  const http = {
    request: async (path: string, options?: unknown) => handler(path, options),
  };
  return new PsnApi(http as unknown as PsnHttpClient);
}

const noNetwork = apiWithStub(() => {
  throw new Error("unexpected network call");
});

test('resolveAccountId passes "me" through without a lookup', async () => {
  assert.equal(await noNetwork.resolveAccountId("me"), "me");
});

test("resolveAccountId passes numeric account ids through", async () => {
  assert.equal(
    await noNetwork.resolveAccountId(" 1234567890123456789 "),
    "1234567890123456789",
  );
});

test("resolveAccountId resolves an online id via search, case-insensitively", async () => {
  const api = apiWithStub(() => ({
    domainResponses: [
      {
        totalResultCount: 2,
        results: [
          {
            id: "a",
            socialMetadata: { accountId: "111", onlineId: "OtherPlayer" },
          },
          {
            id: "b",
            socialMetadata: { accountId: "222", onlineId: "Some_Player" },
          },
        ],
      },
    ],
  }));
  assert.equal(await api.resolveAccountId("some_player"), "222");
});

test("resolveAccountId fails clearly when no exact match exists", async () => {
  const api = apiWithStub(() => ({
    domainResponses: [{ totalResultCount: 0, results: [] }],
  }));
  await assert.rejects(
    api.resolveAccountId("nobody-here"),
    /No PSN user found/,
  );
});

test("getTitleTrophies targets the right endpoint and query", async () => {
  const calls: Array<{ path: string; options?: unknown }> = [];
  const api = apiWithStub((path, options) => {
    calls.push({ path, options });
    return {
      trophies: [],
      totalItemCount: 0,
      trophySetVersion: "1.0",
      hasTrophyGroups: false,
    };
  });
  await api.getTitleTrophies("NPWR20188_00", "trophy2");
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].path,
    "/trophy/v1/npCommunicationIds/NPWR20188_00/trophyGroups/all/trophies",
  );
  assert.deepEqual((calls[0].options as { query: object }).query, {
    npServiceName: "trophy2",
    limit: 200,
    offset: 0,
  });
});
