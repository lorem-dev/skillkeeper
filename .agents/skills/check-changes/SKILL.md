---
name: check-changes
description: >
  Verify that CHANGES.md (Development section) reflects every commit since the
  last release. Flag missing entries, stale entries, or commits that have no
  corresponding changelog bullet.
---

# check-changes

Verify that `CHANGES.md` is current with the commit history since the last
release.

## Steps

1. **Find the last release boundary.**
   Run `git log --oneline` and locate the most recent release commit (a commit
   whose message starts with `chore: release` or a version tag such as `v1.0.0`).
   If no release commit exists yet, the boundary is the initial commit.

2. **Collect commits since that boundary.**

   ```bash
   git log --oneline <boundary>..HEAD
   ```

   Exclude pure merge commits and chore/ci/build commits that do not represent
   user-visible changes (they do not require changelog entries, but note them).

3. **Read the Development section of CHANGES.md.**
   Open `CHANGES.md` and extract every bullet under `## Development`.

4. **Cross-reference.**
   For each commit that represents a user-visible change (type `feat`, `fix`,
   `refactor`, or `perf`), check whether a corresponding bullet exists in the
   Development section. A bullet does not need to quote the commit message
   verbatim -- it only needs to describe the same change at a short summary
   level.

5. **Report findings.**
   - List commits with NO changelog entry (missing entries -- these must be
     added).
   - List changelog bullets that appear to describe nothing in the commit
     history (stale or speculative entries -- flag for author review).
   - If everything matches, report "CHANGES.md is current."

6. **Do not edit CHANGES.md automatically.**
   Propose the missing bullets in your report and let the developer apply them.
   The developer owns the changelog wording.
