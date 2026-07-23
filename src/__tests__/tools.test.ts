import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFriendProfiles } from "../tools.js";
import type { PsnApi } from "../psn/api.js";
import type { UserProfile } from "../psn/types.js";

function psnStub(
  getProfile: (id: string) => Promise<Partial<UserProfile>>,
): Pick<PsnApi, "getProfile"> {
  return { getProfile: getProfile as PsnApi["getProfile"] };
}

test("resolveFriendProfiles resolves account ids to lightweight profiles, in order", async () => {
  const psn = psnStub(async (id) => ({
    onlineId: `Player_${id}`,
    isPlus: id === "111",
  }));

  const resolved = await resolveFriendProfiles(psn, ["111", "222", "333"]);

  assert.deepEqual(resolved, [
    { accountId: "111", onlineId: "Player_111", isPlus: true },
    { accountId: "222", onlineId: "Player_222", isPlus: false },
    { accountId: "333", onlineId: "Player_333", isPlus: false },
  ]);
});

test("resolveFriendProfiles falls back to a bare account id when a profile can't be fetched", async () => {
  const psn = psnStub(async (id) => {
    if (id === "222") throw new Error("profile is private");
    return { onlineId: `Player_${id}`, isPlus: false };
  });

  const resolved = await resolveFriendProfiles(psn, ["111", "222", "333"]);

  assert.deepEqual(resolved, [
    { accountId: "111", onlineId: "Player_111", isPlus: false },
    { accountId: "222" },
    { accountId: "333", onlineId: "Player_333", isPlus: false },
  ]);
});
