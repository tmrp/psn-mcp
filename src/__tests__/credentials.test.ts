import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  credentialsPath,
  loadStoredNpsso,
  saveStoredNpsso,
} from "../psn/credentials.js";

const originalFile = process.env.PSN_NPSSO_FILE;
let tempDir: string | null = null;

afterEach(async () => {
  if (originalFile === undefined) {
    delete process.env.PSN_NPSSO_FILE;
  } else {
    process.env.PSN_NPSSO_FILE = originalFile;
  }
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

test("credentials store round-trips an NPSSO token", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "psn-mcp-credentials-test-"));
  process.env.PSN_NPSSO_FILE = join(tempDir, "nested", "credentials.json");

  assert.equal(await loadStoredNpsso(), null);
  assert.equal(await saveStoredNpsso("npsso-token"), credentialsPath());
  assert.equal(await loadStoredNpsso(), "npsso-token");
});
