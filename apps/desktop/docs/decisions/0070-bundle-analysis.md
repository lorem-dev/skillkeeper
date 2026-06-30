# 0070: Sonda for bundle analysis

## Status

Accepted

## Context

The renderer is the one bundle whose size we care about, so we want trustworthy numbers when
asking "is this chunk too big?". The common per-module bundle visualizers do not give them:
their "Rendered / Gzip / Brotli" figures are pre-minification, per-module estimates. It sums each module's source size and compresses every
module on its own, which has little bearing on the single minified, compressed chunk that
actually ships - and it cannot report raw and compressed sizes accurately at the same time
(turning sourcemaps on fixes the raw sizes but zeroes out gzip/brotli; leaving them off inflates
the compressed figures). For an ESM dependency built from many small modules - say a Markdown or
syntax-highlighting library we would lazy-load to preview a `SKILL.md` - that per-module estimate
can come out several times larger than the byte count the build emits, producing false "the
bundle grew" alarms.

## Decision

Use [Sonda](https://sonda.dev) (`sonda/vite`) as the bundle analyzer. Sonda reads the **emitted
output plus sourcemaps**, so its uncompressed / gzip / brotli numbers are the real per-chunk
sizes and the treemap's compression toggle reflects what ships.

- It is gated on the analyze build only: `electron-vite build --mode analyze`, exposed as the
  `analyze` script in the desktop package and `analyze:desktop` from the workspace root. A normal
  `build`/`dev` leaves the plugin disabled, so the default workflow carries no overhead.
- Sourcemaps are emitted only for the analyze build, since Sonda needs them to attribute emitted
  bytes back to source modules.
- The HTML report is written to `out/analyze/` (under the git-ignored `out/`), not committed.

We keep a bundle-budget mindset: large dependencies are lazy-loaded and watched, and Sonda is how
we confirm a chunk's true weight before deciding whether to split it.

## Consequences

- The analyze build emits sourcemaps (slower, larger output), but that is scoped to the analyze
  mode, so normal and CI builds are untouched.
- Analyzer sizes now match what ships, so chunk-size questions can be answered straight from the
  report, with a working gzip/brotli toggle.
- The build tool's own per-chunk gzip summary stays the fastest authoritative check when no
  treemap is needed.
