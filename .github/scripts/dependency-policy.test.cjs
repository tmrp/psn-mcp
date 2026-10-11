const test = require("node:test");
const assert = require("node:assert/strict");
const { generateKeyPairSync, sign } = require("node:crypto");
const {
  minorOrPatch,
  changeset,
  validateManifest,
  parseLock,
  validateLocks,
  verifyRegistryPackage,
  minimumAge,
} = require("./dependency-policy.cjs");
const {
  latestSuccessful,
  validateFiles,
} = require("./dependabot-automation.cjs");

test("accept patch/minor updates; reject major, 0.x minor, downgrade and nonregistry versions", () => {
  minorOrPatch("^1.2.3", "^1.2.4");
  minorOrPatch("~1.2.3", "^1.3.0");
  for (const [before, after] of [
    ["1.0.0", "2.0.0"],
    ["0.2.0", "0.3.0"],
    ["1.2.0", "1.1.0"],
    ["1.0.0", "1.0.0"],
    ["1.0.0", "1.1.0-beta.1"],
    ["1.0.0", "https://evil.test/x"],
    ["1.0.0", "npm:other@1.1.0"],
  ]) {
    assert.throws(() => minorOrPatch(before, after));
  }
});

test("manifest gate permits dependency-only updates, including grouped development updates", () => {
  const base = {
    name: "psn-mcp",
    version: "0.5.4",
    scripts: { test: "node test" },
    dependencies: { foo: "^1.0.0" },
    devDependencies: { bar: "~2.0.0" },
  };
  const candidate = structuredClone(base);
  candidate.dependencies.foo = "^1.1.0";
  candidate.devDependencies.bar = "~2.0.1";
  assert.equal(validateManifest(base, candidate), 2);
  for (const mutate of [
    (pkg) => {
      pkg.scripts.test = "curl evil";
    },
    (pkg) => {
      pkg.version = "9.0.0";
    },
    (pkg) => {
      pkg.dependencies.new = "1.0.0";
    },
    (pkg) => {
      delete pkg.dependencies.foo;
    },
    (pkg) => {
      pkg.dependencies.foo = "^2.0.0";
    },
  ]) {
    const bad = structuredClone(candidate);
    mutate(bad);
    assert.throws(() => validateManifest(base, bad));
  }
});

const integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
function lock(version = "1.0.0", name = "foo") {
  return {
    lockfileVersion: "9.0",
    settings: { autoInstallPeers: true },
    importers: {
      ".": { dependencies: { foo: { specifier: "^1.0.0", version } } },
    },
    packages: { [`${name}@${version}`]: { resolution: { integrity } } },
    snapshots: {},
  };
}

test("lock gate detects new transitive names, major updates and integrity/source changes", () => {
  assert.equal(validateLocks(lock(), lock("1.0.1")).length, 1);
  assert.throws(() => validateLocks(lock(), lock("1.0.1", "malware")));
  assert.throws(() => validateLocks(lock(), lock("2.0.0")));
  const corrupt = lock();
  corrupt.packages["foo@1.0.0"].resolution.integrity = integrity + "A";
  assert.throws(() => validateLocks(lock(), corrupt));
  const external = lock("1.0.1");
  external.packages["foo@1.0.1"].resolution.tarball =
    "https://evil.test/foo.tgz";
  assert.throws(() => validateLocks(lock(), external));
  const alias = lock("1.0.1");
  alias.importers["."].dependencies.foo.version = "npm:evil@1.0.1";
  assert.throws(() => validateLocks(lock(), alias));
});

test("YAML parser rejects unsupported workspaces and duplicate keys", () => {
  assert.throws(() =>
    parseLock("lockfileVersion: 9.0\nlockfileVersion: 9.0\n"),
  );
  assert.throws(() =>
    parseLock("lockfileVersion: 9.0\nimporters:\n  other: {}\n"),
  );
});

function registryFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const pkg = {
    name: "foo",
    version: "1.0.1",
    previous: "1.0.0",
    key: "foo@1.0.1",
    integrity,
  };
  const now = Date.parse("2026-10-11T00:00:00Z");
  const signatures = [
    {
      keyid: "test-key",
      sig: sign(
        "sha256",
        Buffer.from(`${pkg.key}:${integrity}`),
        privateKey,
      ).toString("base64"),
    },
  ];
  const metadata = {
    time: { "1.0.1": new Date(now - minimumAge - 1000).toISOString() },
    versions: {
      "1.0.0": {
        _npmUser: { name: "maintainer" },
        scripts: { postinstall: "node install.js" },
      },
      "1.0.1": {
        name: "foo",
        version: "1.0.1",
        _npmUser: { name: "maintainer" },
        scripts: { postinstall: "node install.js" },
        dist: {
          integrity,
          tarball: "https://registry.npmjs.org/foo/-/foo-1.0.1.tgz",
          signatures,
        },
      },
    },
  };
  const keys = [
    {
      keyid: "test-key",
      expires: null,
      key: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    },
  ];
  return { pkg, metadata, keys, now };
}

test("verify real ECDSA signature with an aged, unchanged-publisher release", () => {
  const { pkg, metadata, keys, now } = registryFixture();
  verifyRegistryPackage(pkg, metadata, keys, now);
});

test("registry gate fails closed for age, signature, publisher, lifecycle, integrity and missing metadata", () => {
  const mutations = [
    (f) => {
      f.metadata.time["1.0.1"] = new Date(f.now).toISOString();
    },
    (f) => {
      f.metadata.versions["1.0.1"].dist.signatures = [];
    },
    (f) => {
      f.metadata.versions["1.0.1"].dist.signatures[0].sig =
        Buffer.alloc(64).toString("base64");
    },
    (f) => {
      f.metadata.versions["1.0.1"]._npmUser.name = "new-publisher";
    },
    (f) => {
      f.metadata.versions["1.0.1"].scripts.postinstall = "curl evil";
    },
    (f) => {
      f.metadata.versions["1.0.1"].dist.integrity = "wrong";
    },
    (f) => {
      f.metadata.versions["1.0.1"].dist.tarball = "https://evil.test/foo.tgz";
    },
    (f) => {
      f.metadata.versions["1.0.1"].deprecated = "avoid";
    },
    (f) => {
      f.keys[0].expires = "2020-01-01T00:00:00Z";
    },
    (f) => {
      delete f.metadata.time["1.0.1"];
    },
    (f) => {
      delete f.metadata.versions["1.0.0"];
    },
  ];
  for (const mutate of mutations) {
    const fixture = registryFixture();
    mutate(fixture);
    assert.throws(() =>
      verifyRegistryPackage(
        fixture.pkg,
        fixture.metadata,
        fixture.keys,
        fixture.now,
      ),
    );
  }
});

test("PR file gate rejects source, workflow, rename/removal and unexpected changesets", () => {
  validateFiles(
    [
      { filename: "pnpm-lock.yaml", status: "modified" },
      { filename: ".changeset/dependabot-73.md", status: "added" },
    ],
    73,
  );
  for (const filename of [
    "src/index.ts",
    ".github/workflows/ci.yml",
    ".changeset/human.md",
  ])
    assert.throws(() => validateFiles([{ filename, status: "modified" }], 73));
  assert.throws(() =>
    validateFiles([{ filename: "package.json", status: "removed" }], 73),
  );
  assert.throws(() => changeset(-1));
  assert.equal(
    changeset(73),
    '---\n"psn-mcp": patch\n---\n\nUpdate npm dependencies from Dependabot PR #73.\n',
  );
});

test("workflow gate rejects stale, skipped, failed, pending, push and superseded results", () => {
  const path = ".github/workflows/ci.yml";
  const good = {
    id: 1,
    path,
    head_sha: "current",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
  };
  assert(latestSuccessful([good], path, "current"));
  for (const override of [
    { head_sha: "old" },
    { event: "push" },
    { conclusion: "skipped" },
    { conclusion: "failure" },
    { status: "in_progress" },
  ])
    assert(!latestSuccessful([{ ...good, ...override }], path, "current"));
  assert(
    !latestSuccessful(
      [good, { ...good, id: 2, conclusion: "failure" }],
      path,
      "current",
    ),
  );
  assert(!latestSuccessful([], path, "current"));
});
