const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync, existsSync, readdirSync } = require("node:fs");
const { changeset, validateManifest } = require("./dependency-policy.cjs");

const workflowPaths = [
  ".github/workflows/ci.yml",
  ".github/workflows/dependency-safety.yml",
];

function latestSuccessful(runs, path, sha) {
  const matching = runs
    .filter(
      (run) =>
        run.path === path &&
        run.head_sha === sha &&
        run.event === "pull_request",
    )
    .sort((a, b) => b.id - a.id);
  return (
    matching.length > 0 &&
    matching[0].status === "completed" &&
    matching[0].conclusion === "success"
  );
}

function validateFiles(files, number) {
  const path = `.changeset/dependabot-${number}.md`;
  assert(files.length && files.length <= 3, "Unexpected PR file scope");
  for (const file of files) {
    assert(
      (["package.json", "pnpm-lock.yaml"].includes(file.filename) &&
        file.status === "modified") ||
        (file.filename === path && file.status === "added"),
      `Manual review required for ${file.filename}`,
    );
  }
}

function isDependencyBatch(entries) {
  return (
    entries.length > 0 &&
    entries.every(({ name, text }) => {
      const match = /^dependabot-(\d+)\.md$/.exec(name);
      return match && text === changeset(Number(match[1]));
    })
  );
}

module.exports = async function automate({ github, context, core }) {
  const repo = context.repo;
  const run = context.payload.workflow_run;
  if (
    run.event !== "pull_request" ||
    run.head_repository?.full_name !== `${repo.owner}/${repo.repo}`
  )
    return;
  const candidates = await github.paginate(github.rest.pulls.list, {
    ...repo,
    state: "open",
    base: "main",
    per_page: 100,
  });
  const pr = candidates.find(
    (item) =>
      item.head.sha === run.head_sha &&
      (item.user.login === "dependabot[bot]" ||
        (item.head.ref === "changeset-release/main" &&
          item.user.type === "Bot")),
  );
  if (
    !pr ||
    pr.draft ||
    pr.head.repo?.full_name !== `${repo.owner}/${repo.repo}`
  )
    return;

  const runs = await github.paginate(
    github.rest.actions.listWorkflowRunsForRepo,
    { ...repo, head_sha: pr.head.sha, event: "pull_request", per_page: 100 },
  );
  const dependency = pr.user.login === "dependabot[bot]";
  const required = dependency ? workflowPaths : workflowPaths.slice(0, 1);
  if (!required.every((path) => latestSuccessful(runs, path, pr.head.sha))) {
    core.info(
      "Waiting for successful CI/security checks on this exact head commit.",
    );
    return;
  }
  const { data: ref } = await github.rest.git.getRef({
    ...repo,
    ref: "heads/main",
  });
  const baseSha = ref.object.sha;
  const { data: comparison } = await github.rest.repos.compareCommits({
    ...repo,
    base: baseSha,
    head: pr.head.sha,
  });
  if (comparison.status !== "ahead") {
    core.info(
      "PR must include current main. Ask Dependabot to rebase, then rerun the checks.",
    );
    return;
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...repo,
    pull_number: pr.number,
    per_page: 100,
  });
  const getText = async (path, sha) => {
    const { data } = await github.rest.repos.getContent({
      ...repo,
      path,
      ref: sha,
    });
    assert(
      data.type === "file" && data.encoding === "base64",
      `Unsupported file: ${path}`,
    );
    return {
      text: Buffer.from(data.content, "base64").toString("utf8"),
      sha: data.sha,
    };
  };

  if (dependency) {
    validateFiles(files, pr.number);
    const before = JSON.parse((await getText("package.json", baseSha)).text);
    const after = JSON.parse((await getText("package.json", pr.head.sha)).text);
    validateManifest(before, after);
    const path = `.changeset/dependabot-${pr.number}.md`;
    const expected = changeset(pr.number);
    if (!files.some((file) => file.filename === path)) {
      // No candidate checkout, shell interpolation, or privileged execution of PR code.
      const { data: current } = await github.rest.pulls.get({
        ...repo,
        pull_number: pr.number,
      });
      assert.equal(
        current.head.sha,
        pr.head.sha,
        "PR changed during validation",
      );
      await github.rest.repos.createOrUpdateFileContents({
        ...repo,
        path,
        branch: pr.head.ref,
        message: `chore: add changeset for Dependabot PR #${pr.number}`,
        content: Buffer.from(expected).toString("base64"),
      });
      core.info(
        "Changeset added. Its new commit must pass fresh CI/security checks before merging.",
      );
      return;
    }
    assert.equal(
      (await getText(path, pr.head.sha)).text,
      expected,
      "Unexpected bot changeset contents",
    );
  } else {
    // Auto-release only dependency-only batches, never a manually authored changeset.
    assert.equal(
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      baseSha,
      "Trusted checkout is stale",
    );
    const pending = readdirSync(".changeset").filter(
      (name) => name.endsWith(".md") && name !== "README.md",
    );
    if (
      !isDependencyBatch(
        pending.map((name) => ({
          name,
          text: readFileSync(`.changeset/${name}`, "utf8"),
        })),
      )
    ) {
      core.info("Release contains manual changesets; leaving it for review.");
      return;
    }
    execFileSync("pnpm", ["run", "version:packages"], { stdio: "inherit" });
    const expectedPaths = execFileSync("git", ["diff", "--name-only", "HEAD"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(
      files.map((file) => file.filename).sort(),
      expectedPaths,
      "Unexpected release files",
    );
    for (const file of files) {
      if (!existsSync(file.filename)) assert.equal(file.status, "removed");
      else
        assert.equal(
          (await getText(file.filename, pr.head.sha)).text,
          readFileSync(file.filename, "utf8"),
          `Unexpected release content: ${file.filename}`,
        );
    }
  }

  // Respect extra checks as well as the explicit workflow gates above.
  const checks = await github.paginate(github.rest.checks.listForRef, {
    ...repo,
    ref: pr.head.sha,
    filter: "latest",
    per_page: 100,
  });
  if (
    checks.some(
      (check) =>
        check.status !== "completed" ||
        !["success", "neutral", "skipped"].includes(check.conclusion),
    )
  )
    return;
  const { data: statuses } = await github.rest.repos.getCombinedStatusForRef({
    ...repo,
    ref: pr.head.sha,
  });
  if (statuses.statuses.length && statuses.state !== "success") return;
  const { data: current } = await github.rest.pulls.get({
    ...repo,
    pull_number: pr.number,
  });
  const { data: currentBase } = await github.rest.git.getRef({
    ...repo,
    ref: "heads/main",
  });
  assert.equal(current.head.sha, pr.head.sha, "PR changed during validation");
  assert.equal(
    currentBase.object.sha,
    baseSha,
    "main changed during validation",
  );
  if (
    current.state !== "open" ||
    current.draft ||
    current.mergeable !== true ||
    current.mergeable_state !== "clean"
  ) {
    core.info(
      "PR is not cleanly mergeable or repository protections require review.",
    );
    return;
  }
  const { data: result } = await github.rest.pulls.merge({
    ...repo,
    pull_number: pr.number,
    sha: pr.head.sha,
    merge_method: "squash",
  });
  assert(result.merged, result.message);
  core.info(
    `Merged verified PR #${pr.number}; the App-authored merge triggers the release workflow.`,
  );
};

module.exports.latestSuccessful = latestSuccessful;
module.exports.validateFiles = validateFiles;
module.exports.isDependencyBatch = isDependencyBatch;
