const test = require("node:test");
const assert = require("node:assert/strict");
const automate = require("./dependabot-automation.cjs");
const { changeset } = require("./dependency-policy.cjs");

test("auto-release excludes manual, mixed, empty and tampered changeset batches", () => {
  const auto = { name: "dependabot-73.md", text: changeset(73) };
  assert(automate.isDependencyBatch([auto]));
  assert(!automate.isDependencyBatch([]));
  assert(
    !automate.isDependencyBatch([
      auto,
      { name: "human.md", text: changeset(73) },
    ]),
  );
  assert(
    !automate.isDependencyBatch([
      { ...auto, text: auto.text.replace("patch", "major") },
    ]),
  );
  assert(!automate.isDependencyBatch([{ ...auto, name: "dependabot-74.md" }]));
});

function fixture({
  hasChangeset = false,
  failure = false,
  stale = false,
  badFile = false,
  racingHead = false,
  blocked = false,
} = {}) {
  const calls = [];
  const repo = { owner: "tmrp", repo: "psn-mcp" };
  const pr = {
    number: 73,
    user: { login: "dependabot[bot]", type: "Bot" },
    draft: false,
    state: "open",
    head: {
      sha: "head",
      ref: "dependabot/npm_and_yarn/foo",
      repo: { full_name: "tmrp/psn-mcp" },
    },
    mergeable: true,
    mergeable_state: blocked ? "blocked" : "clean",
  };
  const workflowRuns = ["ci.yml", "dependency-safety.yml"].map(
    (name, index) => ({
      id: index + 1,
      path: `.github/workflows/${name}`,
      head_sha: "head",
      event: "pull_request",
      status: "completed",
      conclusion: failure && index === 1 ? "failure" : "success",
    }),
  );
  const files = [
    { filename: "package.json", status: "modified" },
    { filename: "pnpm-lock.yaml", status: "modified" },
  ];
  if (hasChangeset)
    files.push({ filename: ".changeset/dependabot-73.md", status: "added" });
  if (badFile)
    files.push({ filename: ".github/workflows/ci.yml", status: "modified" });
  const rest = {
    pulls: {
      list: async () => {},
      listFiles: async () => {},
      get: async () => ({
        data: {
          ...pr,
          head: { ...pr.head, sha: racingHead ? "racing" : "head" },
        },
      }),
      merge: async (args) => {
        calls.push(["merge", args]);
        return { data: { merged: true } };
      },
    },
    actions: { listWorkflowRunsForRepo: async () => {} },
    checks: { listForRef: async () => {} },
    git: { getRef: async () => ({ data: { object: { sha: "base" } } }) },
    repos: {
      compareCommits: async () => ({
        data: { status: stale ? "diverged" : "ahead" },
      }),
      getContent: async ({ path, ref }) => ({
        data: {
          type: "file",
          encoding: "base64",
          sha: "blob",
          content: Buffer.from(
            path.startsWith(".changeset")
              ? changeset(73)
              : JSON.stringify({
                  name: "psn-mcp",
                  version: "0.5.4",
                  dependencies: { foo: ref === "base" ? "^1.0.0" : "^1.0.1" },
                }),
          ).toString("base64"),
        },
      }),
      createOrUpdateFileContents: async (args) => {
        calls.push(["changeset", args]);
      },
      getCombinedStatusForRef: async () => ({
        data: { statuses: [], state: "pending" },
      }),
    },
  };
  const github = {
    rest,
    paginate: async (method) => {
      if (method === rest.pulls.list) return [pr];
      if (method === rest.pulls.listFiles) return files;
      if (method === rest.actions.listWorkflowRunsForRepo) return workflowRuns;
      if (method === rest.checks.listForRef) return [];
      throw new Error("Unexpected API call");
    },
  };
  const context = {
    repo,
    payload: {
      workflow_run: {
        event: "pull_request",
        head_sha: "head",
        head_repository: { full_name: "tmrp/psn-mcp" },
      },
    },
  };
  return { github, context, core: { info: () => {} }, calls };
}

test("successful original head creates canonical changeset but never merges before fresh checks", async () => {
  const f = fixture();
  await automate(f);
  assert.equal(f.calls.length, 1);
  const [kind, args] = f.calls[0];
  assert.equal(kind, "changeset");
  assert.equal(args.path, ".changeset/dependabot-73.md");
  assert.equal(Buffer.from(args.content, "base64").toString(), changeset(73));
});

test("successful fresh head with canonical changeset merges using expected SHA", async () => {
  const f = fixture({ hasChangeset: true });
  await automate(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], "merge");
  assert.equal(f.calls[0][1].sha, "head");
  assert.equal(f.calls[0][1].merge_method, "squash");
});

test("failed security, stale base and required review cannot write or merge", async () => {
  for (const options of [
    { failure: true },
    { stale: true },
    { hasChangeset: true, blocked: true },
  ]) {
    const f = fixture(options);
    await automate(f);
    assert.deepEqual(f.calls, []);
  }
});

test("unexpected workflow edits or changed head fail before writes/merges", async () => {
  for (const options of [
    { badFile: true },
    { racingHead: true },
    { hasChangeset: true, racingHead: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(automate(f));
    assert.deepEqual(f.calls, []);
  }
});

test("fork/push workflow completions cannot drive privileged automation", async () => {
  for (const mutation of [
    (run) => {
      run.event = "push";
    },
    (run) => {
      run.head_repository.full_name = "attacker/psn-mcp";
    },
  ]) {
    const f = fixture();
    mutation(f.context.payload.workflow_run);
    await automate(f);
    assert.deepEqual(f.calls, []);
  }
});
