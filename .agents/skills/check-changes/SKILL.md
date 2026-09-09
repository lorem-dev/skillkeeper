---
name: check-changes
description: >
  Verify that CHANGES.md (Development section) reflects every commit since the
  last release. Flag missing entries, stale entries, over-long entries, or
  commits that have no corresponding changelog bullet.
---

# check-changes

Verify that `CHANGES.md` is current with the commit history since the last
release.

## Steps

1. **Find the last release boundary.**
   Run `git log --oneline` and locate the most recent release commit (a commit
   whose message starts with `release:` -- the prefix the `bump-version` skill
   uses, e.g. `release: 0.1.0-rc.1` -- or a version tag such as `v1.0.0`).
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
   `CHANGES.md` opens with a comment block stating what qualifies for an entry.
   Read it first; it is authoritative and the rules below restate only what
   this check needs.

   A commit needs a bullet when it adds something a user can use, changes
   behaviour they would be surprised by, removes something, or fixes a bug
   that was BROKEN IN A RELEASED VERSION. A bullet does not need to quote the
   commit message -- it only needs to describe the same change.

   A commit does NOT need one when it is refactoring, a test, CI, an internal
   rename, or a dependency bump with no user-visible effect. Nor when it fixes
   a bug that never shipped: if the last released version did not have the
   defect, the changelog has nothing to say about it. That case is common on a
   long branch and is the one most often reported as a false gap -- check the
   bug's origin before flagging a missing entry, not just the commit's type.

5. **Check each bullet against the length rule.**
   Per the "Changelog Entries" section of CONTRIBUTING.md, a bullet is at most
   **25 words**, counted as whitespace-separated tokens with a code span
   counting as one word. Count every bullet under `## Development` and list the
   ones that exceed it, with their count. Do not measure released `## Version`
   sections -- a section is frozen once cut and is never rewritten.

6. **Check the section against the entry-count limits.**
   `CHANGES.md`'s comment block sets a soft limit of **10** bullets per version
   section and a hard limit of **50**, counting every bullet across its
   subsections. Report the count. Over the soft limit, name the entries that
   look mergeable or cuttable. Over the hard limit, say plainly that the
   release must not ship until they are merged or cut.

7. **Report findings.**
   - List commits with NO changelog entry (missing entries -- these must be
     added).
   - List changelog bullets that appear to describe nothing in the commit
     history (stale or speculative entries -- flag for author review).
   - List bullets over the 25-word limit, each with its count, and propose a
     shorter wording.
   - Report the section's bullet count against the soft and hard limits.
   - If everything matches, report "CHANGES.md is current."

8. **Do not edit CHANGES.md automatically.**
   Propose the missing bullets in your report and let the developer apply them.
   The developer owns the changelog wording.
