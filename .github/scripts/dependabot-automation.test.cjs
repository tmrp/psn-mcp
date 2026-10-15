const test = require('node:test');
const assert = require('node:assert/strict');
const automate = require('./dependabot-automation.cjs');
const { changeset } = require('./dependency-policy.cjs');

test('auto-release excludes manual, mixed, empty and tampered changeset batches', () => {
  const auto = { name: 'dependabot-73.md', text: changeset(73) };
  assert(automate.isDependencyBatch([auto]));
  assert(!automate.isDependencyBatch([]));
  assert(
    !automate.isDependencyBatch([
      auto,
      { name: 'human.md', text: changeset(73) },
    ]),
  );
  assert(
    !automate.isDependencyBatch([
      { ...auto, text: auto.text.replace('patch', 'major') },
    ]),
  );
  assert(!automate.isDependencyBatch([{ ...auto, name: 'dependabot-74.md' }]));
});

function fixture(...specs) {
  const calls = [];
  const warnings = [];
  const repo = { owner: 'tmrp', repo: 'psn-mcp' };
  const prs = (specs.length ? specs : [{}]).map(
    ({ number = 73, ...options }) => ({
      options,
      pr: {
        number,
        user: { login: 'dependabot[bot]', type: 'Bot' },
        draft: false,
        state: 'open',
        head: {
          sha: `head-${number}`,
          ref: `dependabot/npm_and_yarn/foo-${number}`,
          repo: { full_name: 'tmrp/psn-mcp' },
        },
      },
    }),
  );
  const byNumber = (number) => prs.find(({ pr }) => pr.number === number);
  const bySha = (sha) => prs.find(({ pr }) => pr.head.sha === sha);
  const byRef = (ref) => prs.find(({ pr }) => pr.head.ref === ref);
  const workflowRuns = ({ pr, options }) =>
    ['ci.yml', 'dependency-safety.yml'].map((name, index) => ({
      id: index + 1,
      path: `.github/workflows/${name}`,
      head_sha: pr.head.sha,
      event: 'pull_request',
      status: 'completed',
      conclusion: options.failure && index === 1 ? 'failure' : 'success',
    }));
  const files = ({ pr, options }) => [
    { filename: 'package.json', status: 'modified' },
    { filename: 'pnpm-lock.yaml', status: 'modified' },
    ...(options.hasChangeset
      ? [{ filename: `.changeset/dependabot-${pr.number}.md`, status: 'added' }]
      : []),
    ...(options.badFile
      ? [{ filename: '.github/workflows/ci.yml', status: 'modified' }]
      : []),
  ];
  const rest = {
    pulls: {
      list: async () => {},
      listFiles: async () => {},
      get: async ({ pull_number }) => {
        const { pr, options } = byNumber(pull_number);
        return {
          data: {
            ...pr,
            head: {
              ...pr.head,
              sha: options.racingHead ? 'racing' : pr.head.sha,
            },
            mergeable: true,
            mergeable_state: options.blocked ? 'blocked' : 'clean',
          },
        };
      },
      merge: async (args) => {
        calls.push(['merge', args]);
        return { data: { merged: true } };
      },
    },
    actions: { listWorkflowRunsForRepo: async () => {} },
    checks: { listForRef: async () => {} },
    git: { getRef: async () => ({ data: { object: { sha: 'base' } } }) },
    repos: {
      compareCommits: async ({ head }) => ({
        data: { status: bySha(head).options.stale ? 'behind' : 'ahead' },
      }),
      merge: async (args) => {
        if (byRef(args.base).options.conflict)
          throw Object.assign(new Error('Merge conflict'), { status: 409 });
        calls.push(['update', args]);
        return { data: {} };
      },
      getContent: async ({ path, ref }) => ({
        data: {
          type: 'file',
          encoding: 'base64',
          sha: 'blob',
          content: Buffer.from(
            path.startsWith('.changeset')
              ? changeset(Number(/(\d+)/.exec(path)[1]))
              : JSON.stringify({
                  name: 'psn-mcp',
                  version: '0.5.4',
                  dependencies: { foo: ref === 'base' ? '^1.0.0' : '^1.0.1' },
                }),
          ).toString('base64'),
        },
      }),
      createOrUpdateFileContents: async (args) => {
        calls.push(['changeset', args]);
      },
      getCombinedStatusForRef: async () => ({
        data: { statuses: [], state: 'pending' },
      }),
    },
  };
  const github = {
    rest,
    paginate: async (method, params) => {
      // Newest first, so the tests also cover the controller's ordering.
      if (method === rest.pulls.list) return prs.map(({ pr }) => pr).reverse();
      if (method === rest.pulls.listFiles)
        return files(byNumber(params.pull_number));
      if (method === rest.actions.listWorkflowRunsForRepo)
        return workflowRuns(bySha(params.head_sha));
      if (method === rest.checks.listForRef) return [];
      throw new Error('Unexpected API call');
    },
  };
  const context = {
    repo,
    payload: {
      workflow_run: {
        event: 'pull_request',
        head_sha: 'head-73',
        head_branch: 'dependabot/npm_and_yarn/foo-73',
        head_repository: { full_name: 'tmrp/psn-mcp' },
      },
    },
  };
  const core = {
    info: () => {},
    warning: (message) => warnings.push(message),
    error: () => {},
  };
  return { github, context, core, calls, warnings };
}

test('successful original head creates canonical changeset but never merges before fresh checks', async () => {
  const f = fixture();
  await automate(f);
  assert.equal(f.calls.length, 1);
  const [kind, args] = f.calls[0];
  assert.equal(kind, 'changeset');
  assert.equal(args.path, '.changeset/dependabot-73.md');
  assert.equal(Buffer.from(args.content, 'base64').toString(), changeset(73));
  // Dependabot may still rebase over the bot commit to resolve conflicts.
  assert.match(args.message, /\[dependabot skip\]/);
});

test('successful fresh head with canonical changeset merges using expected SHA', async () => {
  const f = fixture({ hasChangeset: true });
  await automate(f);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'merge');
  assert.equal(f.calls[0][1].sha, 'head-73');
  assert.equal(f.calls[0][1].merge_method, 'squash');
});

test('failed security and required review cannot write or merge', async () => {
  for (const options of [
    { failure: true },
    { hasChangeset: true, blocked: true },
  ]) {
    const f = fixture(options);
    await automate(f);
    assert.deepEqual(f.calls, []);
  }
});

test('a verified PR behind main gets current main merged in, never a changeset or merge', async () => {
  for (const options of [
    { stale: true },
    { stale: true, hasChangeset: true },
  ]) {
    const f = fixture(options);
    await automate(f);
    assert.equal(f.calls.length, 1);
    const [kind, args] = f.calls[0];
    assert.equal(kind, 'update');
    assert.equal(args.base, 'dependabot/npm_and_yarn/foo-73');
    assert.equal(args.head, 'base');
    assert.match(args.commit_message, /\[dependabot skip\]/);
  }
});

test('a conflicting update is left for Dependabot to rebase without failing', async () => {
  const f = fixture({ stale: true, conflict: true });
  await automate(f);
  assert.deepEqual(f.calls, []);
  assert.equal(f.warnings.length, 1);
});

test('stale or failed PRs are never updated with main', async () => {
  const f = fixture({ stale: true, failure: true });
  await automate(f);
  assert.deepEqual(f.calls, []);
});

test('unexpected workflow edits or changed head fail before writes/merges', async () => {
  for (const options of [
    { badFile: true },
    { badFile: true, stale: true },
    { racingHead: true },
    { hasChangeset: true, racingHead: true },
  ]) {
    const f = fixture(options);
    await assert.rejects(automate(f));
    assert.deepEqual(f.calls, []);
  }
});

test('only same-repository PR completions and main pushes wake the controller', async () => {
  for (const mutation of [
    (run) => {
      run.event = 'push';
    },
    (run) => {
      run.head_repository.full_name = 'attacker/psn-mcp';
    },
  ]) {
    const f = fixture();
    mutation(f.context.payload.workflow_run);
    await automate(f);
    assert.deepEqual(f.calls, []);
  }
  const f = fixture();
  Object.assign(f.context.payload.workflow_run, {
    event: 'push',
    head_branch: 'main',
  });
  await automate(f);
  assert.equal(f.calls.length, 1);
});

test('every run sweeps all candidate PRs, so cancelled pending runs lose no work', async () => {
  const f = fixture({ number: 75 }, { number: 76 });
  f.context.payload.workflow_run.head_sha = 'unrelated';
  await automate(f);
  assert.deepEqual(
    f.calls.map(([kind, args]) => [kind, args.path]),
    [
      ['changeset', '.changeset/dependabot-75.md'],
      ['changeset', '.changeset/dependabot-76.md'],
    ],
  );
});

test('a sweep merges the oldest ready PR and stops because main moved', async () => {
  const f = fixture(
    { number: 75, hasChangeset: true },
    { number: 76, hasChangeset: true },
  );
  await automate(f);
  assert.deepEqual(
    f.calls.map(([kind, args]) => [kind, args.pull_number]),
    [['merge', 75]],
  );
});

test('a PR needing manual review fails the run without blocking other PRs', async () => {
  const f = fixture({ number: 75, badFile: true }, { number: 76 });
  await assert.rejects(automate(f), /manual review/);
  assert.deepEqual(
    f.calls.map(([kind, args]) => [kind, args.path]),
    [['changeset', '.changeset/dependabot-76.md']],
  );
});
