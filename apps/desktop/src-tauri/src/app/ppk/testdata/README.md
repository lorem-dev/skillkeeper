# PPK test fixtures

Throwaway PuTTY keys used only by the unit tests in `app/ppk/`. They are not
credentials: they were generated locally with `puttygen`, have never been
installed anywhere, and grant access to nothing. The encrypted ones use the
passphrase `skillkeeper-test`.

Each `<name>.ppk` has a `<name>.openssh` sibling: the same key as written by
`puttygen -O private-openssh-new`. That file is the expected output of our own
conversion, so a mismatch means our conversion is wrong, not that the fixture
is stale. Regenerate both together with `./regenerate.sh` in this directory
(requires `puttygen` on `PATH`).

`dsa-v2-plain.ppk` and `dsa-v2-enc.ppk` have no `.openssh` sibling: DSA is a
rejection fixture, and the only tests that read them assert the algorithm is
rejected before any crypto runs, so no converted form is needed. The encrypted
one exists specifically so "rejected before decrypting" can be told apart from
"rejected because the passphrase was wrong": only a key that actually has
something to decrypt can distinguish the two.
