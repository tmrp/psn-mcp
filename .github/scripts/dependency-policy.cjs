const assert = require("node:assert/strict");
const { createPublicKey, verify } = require("node:crypto");
const { readFileSync } = require("node:fs");
const YAML = require("yaml");

const sections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const minimumAge = 14 * 24 * 60 * 60 * 1000;

function version(value) {
  const match = /^(?:\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(value);
  assert(match, `Unsupported or prerelease version: ${value}`);
  return match.slice(1).map(Number);
}

function minorOrPatch(before, after) {
  const a = version(before);
  const b = version(after);
  assert(a[0] === b[0], "Major updates require manual review");
  assert(
    a[0] !== 0 || a[1] === b[1],
    "0.x minor updates require manual review",
  );
  assert(
    b[1] > a[1] || (b[1] === a[1] && b[2] > a[2]),
    "Expected a version increase",
  );
}

function changeset(number) {
  assert(Number.isSafeInteger(number) && number > 0);
  return `---\n"psn-mcp": patch\n---\n\nUpdate npm dependencies from Dependabot PR #${number}.\n`;
}

function validateManifest(before, after) {
  const rest = (manifest) =>
    Object.fromEntries(
      Object.entries(manifest).filter(([key]) => !sections.includes(key)),
    );
  assert.deepEqual(
    rest(after),
    rest(before),
    "Only dependency versions may change",
  );
  let count = 0;
  for (const section of sections) {
    assert.deepEqual(
      Object.keys(after[section] || {}).sort(),
      Object.keys(before[section] || {}).sort(),
      "Adding, removing or moving dependencies requires review",
    );
    for (const [name, value] of Object.entries(after[section] || {})) {
      if (before[section][name] === value) continue;
      assert(
        /^(?:\^|~)?\d+\.\d+\.\d+$/.test(value),
        `Non-registry dependency: ${name}`,
      );
      minorOrPatch(before[section][name], value);
      count++;
    }
  }
  return count;
}

function parseLock(text) {
  const lock = YAML.parse(text, { maxAliasCount: 0, uniqueKeys: true });
  assert.equal(String(lock.lockfileVersion), "9.0");
  assert.deepEqual(
    Object.keys(lock.importers),
    ["."],
    "Workspace changes require review",
  );
  return lock;
}

function packages(lock) {
  return Object.entries(lock.packages || {}).map(([key, entry]) => {
    const match = /^(@[^/]+\/[^@]+|[^@/]+)@(\d+\.\d+\.\d+)$/.exec(key);
    assert(match, `Unsupported package source or prerelease: ${key}`);
    assert.deepEqual(
      Object.keys(entry.resolution || {}),
      ["integrity"],
      `Custom package source: ${key}`,
    );
    assert(
      /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.resolution.integrity),
      `Missing SHA-512 integrity: ${key}`,
    );
    return {
      key,
      name: match[1],
      version: match[2],
      integrity: entry.resolution.integrity,
      entry,
    };
  });
}

function validateLocks(before, after) {
  const config = (lock) =>
    Object.fromEntries(
      Object.entries(lock).filter(
        ([key]) => !["packages", "snapshots", "importers"].includes(key),
      ),
    );
  assert.deepEqual(
    config(after),
    config(before),
    "Lockfile configuration changes require review",
  );
  const oldRoot = before.importers["."];
  const newRoot = after.importers["."];
  assert.deepEqual(
    Object.keys(newRoot).sort(),
    Object.keys(oldRoot).sort(),
    "Importer configuration changed",
  );
  for (const section of Object.keys(newRoot)) {
    assert(
      sections.includes(section),
      `Unsupported importer section: ${section}`,
    );
    assert.deepEqual(
      Object.keys(newRoot[section]).sort(),
      Object.keys(oldRoot[section]).sort(),
      "Direct dependency names changed",
    );
    for (const [name, value] of Object.entries(newRoot[section])) {
      assert.deepEqual(Object.keys(value).sort(), ["specifier", "version"]);
      version(value.specifier);
      const oldVersion = oldRoot[section][name].version.split("(")[0];
      const newVersion = value.version.split("(")[0];
      version(newVersion);
      if (oldVersion !== newVersion) minorOrPatch(oldVersion, newVersion);
    }
  }
  const oldPackages = packages(before);
  const oldByKey = new Map(oldPackages.map((pkg) => [pkg.key, pkg]));
  const changed = [];
  for (const pkg of packages(after)) {
    if (oldByKey.has(pkg.key)) {
      assert.deepEqual(
        pkg.entry,
        oldByKey.get(pkg.key).entry,
        `Existing package metadata changed: ${pkg.key}`,
      );
      continue;
    }
    const previous = oldPackages.filter((old) => old.name === pkg.name);
    assert(
      previous.length,
      `New transitive package requires review: ${pkg.name}`,
    );
    // A transitive major or downgrade also needs a human, even in a minor PR.
    const baseline = previous.find((old) => {
      try {
        minorOrPatch(old.version, pkg.version);
        return true;
      } catch {
        return false;
      }
    });
    assert(baseline, `Transitive major/downgrade requires review: ${pkg.key}`);
    changed.push({ ...pkg, previous: baseline.version });
  }
  assert(changed.length, "No resolved dependency updates found");
  return changed;
}

function verifyRegistryPackage(pkg, metadata, keys, now = Date.now()) {
  const current = metadata.versions?.[pkg.version];
  const previous = metadata.versions?.[pkg.previous];
  assert(current && previous, `Missing registry metadata: ${pkg.key}`);
  assert.equal(current.name, pkg.name);
  assert.equal(current.version, pkg.version);
  const published = Date.parse(metadata.time?.[pkg.version]);
  assert(
    Number.isFinite(published) && now - published >= minimumAge,
    `Package must be at least 14 days old: ${pkg.key}`,
  );
  assert(!current.deprecated, `Deprecated package: ${pkg.key}`);
  assert.equal(
    current.dist?.integrity,
    pkg.integrity,
    `Registry/lockfile integrity mismatch: ${pkg.key}`,
  );
  assert.equal(
    new URL(current.dist.tarball).origin,
    "https://registry.npmjs.org",
  );
  assert(
    current._npmUser?.name && current._npmUser.name === previous._npmUser?.name,
    `Publisher changed or unknown: ${pkg.key}`,
  );
  for (const script of ["preinstall", "install", "postinstall", "prepare"]) {
    assert.equal(
      current.scripts?.[script],
      previous.scripts?.[script],
      `Lifecycle script changed: ${pkg.key} (${script})`,
    );
  }
  assert(
    current.dist.signatures?.some((signature) => {
      const key = keys.find((item) => item.keyid === signature.keyid);
      if (!key || (key.expires && Date.parse(key.expires) <= published))
        return false;
      return verify(
        "sha256",
        Buffer.from(`${pkg.key}:${pkg.integrity}`),
        createPublicKey({
          key: Buffer.from(key.key, "base64"),
          format: "der",
          type: "spki",
        }),
        Buffer.from(signature.sig, "base64"),
      );
    }),
    `Missing or invalid npm registry signature: ${pkg.key}`,
  );
}

async function registry(path) {
  const response = await fetch(`https://registry.npmjs.org/${path}`, {
    signal: AbortSignal.timeout(30000),
    redirect: "error",
  });
  assert(response.ok, `npm registry request failed (${response.status})`);
  return response.json();
}

async function main(base, candidate) {
  const manifest = (dir) =>
    JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
  validateManifest(manifest(base), manifest(candidate));
  const lock = (dir) =>
    parseLock(readFileSync(`${dir}/pnpm-lock.yaml`, "utf8"));
  const changed = validateLocks(lock(base), lock(candidate));
  const { keys } = await registry("-/npm/v1/keys");
  const metadata = new Map();
  for (const pkg of changed) {
    if (!metadata.has(pkg.name))
      metadata.set(pkg.name, await registry(encodeURIComponent(pkg.name)));
    verifyRegistryPackage(pkg, metadata.get(pkg.name), keys);
    console.log(`Verified ${pkg.key}`);
  }
}

module.exports = {
  version,
  minorOrPatch,
  changeset,
  validateManifest,
  parseLock,
  validateLocks,
  verifyRegistryPackage,
  minimumAge,
};
if (require.main === module) {
  // Both directories are immutable checkouts; never execute scripts from candidate.
  const [base, candidate] = process.argv.slice(2);
  main(base, candidate).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
