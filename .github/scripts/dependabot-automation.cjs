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

// Completions only wake the controller; it re-verifies every PR itself.
function isTrustedTrigger(run, repo) {
  return (
    run?.head_repository?.full_name === `${repo.owner}/${repo.repo}` &&
    (run.event === "pull_request" ||
      (run.event === "push" && run.head_branch === "main"))
  );
}

function isCandidate(pr, repo) {
  return (
    !pr.draft &&
    pr.head.repo?.full_name === `${repo.owner}/${repo.repo}` &&
    (pr.user.login === "dependabot[bot]" ||
      (pr.head.ref === "changeset-release/main" && pr.user.type === "Bot"))
  );
}

// Returns true after merging: main moved, so the rest wait for the next sweep.
async function processPullRequest({ github, core, repo, pr, baseSha }) {
  const log = (message) => core.info(`PR #${pr.number}: ${message}`);
  const runs = await github.paginate(
    github.rest.actions.listWorkflowRunsForRepo,
    { ...repo, head_sha: pr.head.sha, event: "pull_request", per_page: 100 },
  );
  const dependency = pr.user.login === "dependabot[bot]";
  const required = dependency ? workflowPaths : workflowPaths.slice(0, 1);
  if (!required.every((path) => latestSuccessful(runs, path, pr.head.sha))) {
    log("Waiting for successful CI/security checks on this exact head commit.");
    return false;
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {
    ...repo,
    pull_number: pr.number,
    per_page: 100,
  });
  if (dependency) validateFiles(files, pr.number);
  const { data: comparison } = await github.rest.repos.compareCommits({
    ...repo,
    base: baseSha,
    head: pr.head.sha,
  });
  if (comparison.status !== "ahead") {
    if (!dependency) {
      log("Waiting for Changesets to rebuild the release PR on current main.");
      return false;
    }
    // Strict branch protection requires current main. The skip marker keeps
    // Dependabot able to rebase over this commit when its lockfile conflicts.
    try {
      await github.rest.repos.merge({
        ...repo,
        base: pr.head.ref,
        head: baseSha,
        commit_message: `chore: merge main into Dependabot PR #${pr.number} [dependabot skip]`,
      });
      log("Merged current main; the new commit must pass fresh checks.");
    } catch (error) {
      core.warning(
        `PR #${pr.number} could not be updated with main (${error.message}). ` +
          "Dependabot rebases conflicting PRs itself; otherwise comment `@dependabot recreate`.",
      );
    }
    return false;
  }
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
        message: `chore: add changeset for Dependabot PR #${pr.number} [dependabot skip]`,
        content: Buffer.from(expected).toString("base64"),
      });
      log(
        "Changeset added. Its new commit must pass fresh CI/security checks before merging.",
      );
      return false;
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
      log("Release contains manual changesets; leaving it for review.");
      return false;
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
    return false;
  const { data: statuses } = await github.rest.repos.getCombinedStatusForRef({
    ...repo,
    ref: pr.head.sha,
  });
  if (statuses.statuses.length && statuses.state !== "success") return false;
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
    log(
      "PR is not cleanly mergeable or repository protections require review.",
    );
    return false;
  }
  const { data: result } = await github.rest.pulls.merge({
    ...repo,
    pull_number: pr.number,
    sha: pr.head.sha,
    merge_method: "squash",
  });
  assert(result.merged, result.message);
  log("Merged; the App-authored merge triggers the release workflow.");
  return true;
}

module.exports = async function automate({ github, context, core }) {
  const repo = context.repo;
  if (!isTrustedTrigger(context.payload.workflow_run, repo)) return;
  // Sweep every candidate, not just the triggering PR: the concurrency group
  // cancels superseded pending runs, so their events would otherwise be lost.
  const isRelease = (pr) => Number(pr.user.login !== "dependabot[bot]");
  const prs = (
    await github.paginate(github.rest.pulls.list, {
      ...repo,
      state: "open",
      base: "main",
      per_page: 100,
    })
  )
    .filter((pr) => isCandidate(pr, repo))
    // Dependency PRs first (oldest first) so they join the pending release.
    .sort((a, b) => isRelease(a) - isRelease(b) || a.number - b.number);
  const { data: ref } = await github.rest.git.getRef({
    ...repo,
    ref: "heads/main",
  });
  const errors = [];
  for (const pr of prs) {
    try {
      const args = { github, core, repo, pr, baseSha: ref.object.sha };
      // The merge's push to main runs CI, which wakes the next sweep.
      if (await processPullRequest(args)) break;
    } catch (error) {
      core.error(`PR #${pr.number}: ${error.message}`);
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(errors, "Some PRs require manual review");
};

module.exports.latestSuccessful = latestSuccessful;
module.exports.validateFiles = validateFiles;
module.exports.isDependencyBatch = isDependencyBatch;
