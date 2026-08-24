#!/usr/bin/env node
// Verify a release tag was cut from the branch its kind belongs on.
// Usage: node scripts/check-tag-branch.mjs [tag]
// Tag falls back to $GITHUB_REF_NAME.
//
//   v<version>-rc.<n>  release candidate -> must be on develop
//   v<version>         final release     -> must be on main
//
// A release candidate exists to exercise the pipeline before the work reaches the
// release branch, so it is cut from develop on purpose. A FINAL tag on develop
// would publish a release from unmerged code, which is the mistake this guard
// exists to stop -- and it stops it in the pipeline's first job, before anything
// is built, signed, or published.
//
// "On" a branch means reachable from it (`git merge-base --is-ancestor`), not
// equal to its tip: a tag stays valid as the branch moves on.

import { spawnSync } from 'node:child_process';

const rawTag = process.argv[2] ?? process.env['GITHUB_REF_NAME'];
if (!rawTag) {
  console.error('check-tag-branch: no tag given (arg or $GITHUB_REF_NAME)');
  process.exit(1);
}

/** Run git and return trimmed stdout, or null when the command fails. */
function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

// A pre-release suffix is what distinguishes a candidate: v1.2.3-rc.1, and also
// any other `-` qualifier (beta, alpha) we might use later.
const isPrerelease = /-/.test(rawTag.replace(/^v/, ''));
const expected = isPrerelease ? 'develop' : 'main';
const kind = isPrerelease ? 'release candidate' : 'final release';

// Resolve the branch remotely first (CI checks out a detached tag, so local
// branch refs may not exist), then fall back to a local ref for developer runs.
const candidates = [`refs/remotes/origin/${expected}`, `refs/heads/${expected}`];
let branchRef = null;
for (const ref of candidates) {
  if (git(['rev-parse', '--verify', '--quiet', ref]) !== null) {
    branchRef = ref;
    break;
  }
}
if (branchRef === null) {
  console.error(
    `check-tag-branch: cannot resolve ${expected}. Fetch it first ` +
      `(git fetch origin ${expected}); a shallow clone needs fetch-depth: 0.`,
  );
  process.exit(1);
}

const tagSha = git(['rev-list', '-n', '1', rawTag]);
if (tagSha === null) {
  console.error(`check-tag-branch: cannot resolve tag ${rawTag}`);
  process.exit(1);
}

const reachable = spawnSync('git', ['merge-base', '--is-ancestor', tagSha, branchRef]).status === 0;

if (!reachable) {
  console.error(
    `check-tag-branch: ${rawTag} is a ${kind}, which must be cut from ` +
      `${expected}, but ${tagSha.slice(0, 8)} is not reachable from ${branchRef}.`,
  );
  if (!isPrerelease) {
    console.error(
      '  A final release is tagged on main, after develop merges there. To ' +
        'validate a build from develop, cut an -rc tag instead.',
    );
  }
  process.exit(1);
}

console.log(`check-tag-branch: ${rawTag} is a ${kind} and is on ${expected}.`);
