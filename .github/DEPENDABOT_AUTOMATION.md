# Dependabot automation

Minor and patch npm updates (including grouped and development updates) receive a
patch changeset for `psn-mcp`. Updating a dependency does not add a public API
feature, so it does not imply a minor release of this package. Major updates and
potentially breaking 0.x minor updates stay manual.

## One-time setup

Create a GitHub App, install it on **only this repository**, and grant repository
permissions **Contents: read/write**, **Pull requests: read/write**,
**Actions: read**, and **Checks: read**. No administration, workflows, or bypass
permission is needed. Set:

- Repository variable `DEPENDABOT_AUTOMATION_APP_ID` to the App's numeric ID.
- Actions secret `DEPENDABOT_AUTOMATION_PRIVATE_KEY` to the App's PEM private key.

The App is necessary because pushes/PRs created with `GITHUB_TOKEN` do not trigger
ordinary CI or release workflows. Short-lived installation tokens are limited to
this repository. Never use an administrator PAT for this automation. Without the
App configuration the automation cannot write or merge; ordinary manual releases
continue using `GITHUB_TOKEN`.

Enable the dependency graph for Dependency Review. npm trusted publishing (or the
existing `NPM_TOKEN` fallback) must remain configured for `release.yml`.
Repository auto-merge does **not** need to be enabled. Existing branch rules and
required reviews are respected; do not add a bypass for the App.

## Sequence

1. Read-only CI builds, tests, typechecks, and lints the PR. Dependency Safety uses
   policy code from the trusted base and reads the candidate solely as data.
2. The privileged `workflow_run` controller requires the latest CI **and**
   Dependency Safety runs to succeed on the PR's exact current SHA. It accepts
   only same-repository Dependabot PRs targeting main and dependency file changes.
3. It adds one deterministic `.changeset/dependabot-N.md`. The App's commit triggers
   fresh CI and security runs. The previous SHA's results cannot authorize a merge.
4. After both fresh runs pass, the controller squashes the PR with an expected-head
   SHA. It checks extra checks/statuses, a clean merge state, and current main too.
5. The merge triggers Changesets, which opens/updates its normal version PR using
   the App token. After CI passes, the controller can merge that version PR **only
   when every pending changeset is an unchanged generated Dependabot changeset**.
   It regenerates the expected version files from trusted main and compares every
   changed file before merging. Mixed/manual batches remain for human review.
6. The version PR merge triggers the existing npm publish/provenance and GitHub
   release synchronization workflow. No new npm publishing credentials are added.

## Security policy and manual review

All known vulnerability severities fail the full pnpm audit and Dependency Review.
All new resolved versions, including transitives, must be at least **14 days old**,
match their registry SHA-512 integrity, and have a valid npm ECDSA registry signature.
Registry URLs must be public npm. Changes in publisher or lifecycle scripts, new
transitive package names, major/downgraded transitive versions, prereleases, aliases,
git/URL sources, missing metadata, or changed existing lockfile package records
require manual review. Scanning errors fail closed. The safety job never installs
candidate dependencies or runs their lifecycle scripts. PR CI has read-only
permissions; it has no publishing or App credentials.

These checks reduce risk; signatures prove registry integrity, not that code is
benign. An established publisher can still ship malicious code. This policy does
not claim malware detection or cryptographic verification of Sigstore provenance.
Urgent security fixes younger than 14 days also stay manual. Review blocked PRs
without weakening the global gate. If main advances, request `@dependabot rebase`
and rerun checks; the controller refuses stale branches. Existing PRs need a new
Dependabot push or a rerun of CI and Dependency Safety after setup/merge.
