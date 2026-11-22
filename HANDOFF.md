# HANDOFF — site-generator-speed-01-run-20261122 entry

A faster drop-in for makefun-site 1.0.0: `solve.js` exports `run(input)` returning
exactly the reference `build(input)` output tree, byte for byte. Written from the
kit's README spec with the reference code as authority; no kit files copied into
the entry. Not pushed, not bundled, not kit-checked, not submitted (parent does
that after review).

## Files written

- `solve.js` (1,518 lines) — the whole implementation: front matter, Markdown
  (fused block pass + range-based inline), template dialect (flat node arrays),
  slug/date/escape helpers, and the build pipeline. Dependency-free ES module.
- `main.ts` — harness driver with the house contract: reads `/input/cases.json`,
  answers each case alone with `run`, writes `/output/answers.json`;
  `MAKEFUN_INPUT_DIR`/`MAKEFUN_OUTPUT_DIR` stand in outside a container;
  `--no-incremental-marking` set before importing `solve.js`.
- `LICENSE` — MIT with SPDX identifier.
- `README.md` — entry summary.
- `.makefun/owner.json` — `{"wallet":"9JWx4L4pSeMp55cHgCVgbkrAQcvXW94o2LHZWc434Htk"}`.

Total entry size ~55 KB (limit 4 MiB).

## Correctness (gate 1 + 2)

- Practice set: **3/3 cases deep-equal** vs `practice/reference/expected.json`,
  and **double-run identical** (JSON.stringify equal across two runs).
- Driver end-to-end: `node main.ts` on the practice input produces
  `answers.json` matching expected 3/3.
- Generator fuzz: **120/120 identical** vs baseline `build()` on extra cases
  drawn with the kit's own generator (`subject/sites.mjs` + `rng.ts streamFor`,
  40 arbitrary seeds × 3 cases — same distribution as the scored set).
- Edge fuzz: **256/256 identical** vs baseline `build()` — hand-crafted cases
  covering front-matter refusals (every reason string, check order, quoted-string
  escapes, date validity incl. leap rules, tag/slug/layout grammars), Markdown
  edges (fences, headings 1–7 `#`, hr variants, quotes, lists + continuations,
  nested strong/em/code/links, backslash escapes, link resolution incl.
  `..`/fragments/schemes/broken links, unicode + long slugs, heading-id dedupe),
  template edges (every parse-error string, standalone-line rule, include depth
  8, include cycles, for-loop shadowing of `site`/`loop`, truthiness, array/number
  text, `length` paths), structural edges (reserved slugs/dirs, shadowing
  statics incl. `build-report.txt`, duplicate paths, missing templates,
  per_page/recent/base_url edges), plus mutations of generated cases (appended
  edge Markdown, replaced/broken templates, broken front matter, dropped
  index/tag/tags templates, shadowing statics).

## Speed (gate 3)

Method: interleaved rounds in one process (9 rounds, order alternated), CPU time
via `process.cpuUsage` deltas around each `run()`/`build()` call, Node v22.23.5
(`~/workspace/node22/current/bin/node`), medians reported. Baseline = kit
`baselines/makefun-site/solve.js` (vendor build). Practice cases:

| case   | mine (median) | baseline (median) | speedup |
|--------|--------------:|------------------:|--------:|
| g-0001 |       42.3 ms |          164.5 ms |   3.88× |
| g-0002 |       85.4 ms |          275.0 ms |   3.22× |
| g-0003 |       99.6 ms |          274.7 ms |   2.76× |
| total  |      227.4 ms |          714.2 ms |   3.14× |

Repeated runs of the same bench gave totals of 2.97×–3.14× (shared-CPU VM is
noisy; the grading heat uses a dedicated 1-CPU container). Clearly faster than
baseline on every case, with a wide margin over the 95%-confidence bar.

Where the speed comes from: bulk HTML escaping over plain-text ranges (baseline
escapes per character), single-pass fused Markdown block rendering (no token
objects), range-based inline rendering (no recursive substring copies),
indexOf-based scans for specials/escapables/closers, templates compiled to flat
node arrays rendered into a parts array joined once, reuse of loop scope objects,
memoised renders of case-constant include templates (header/footer/nav/strips —
free-name analysis, depth-keyed, shadowing-checked), ASCII fast path + per-case
memoisation for slugs, per-case link-resolution memo, manual word-count scan
fused into the line pass. Nothing is cached between cases: every memo table is
created inside `run()`.

## Known risks

- The constant-include memo is the only non-obvious optimization: a template is
  memoised only when every name it references free (transitively through
  includes, fixpoint over cycles) is one of `site`/`tags`/`recent`, the memo is
  keyed by include depth, and renders under a loop that binds one of those names
  bypass the memo entirely. Covered by edge-fuzz cases for shadowing, depth
  chains, cycles and repeated includes, plus 120 generator cases.
- Slugify skips NFKD for pure-ASCII text (ASCII is stable under NFKD and holds
  no combining marks); any non-ASCII character takes the full
  normalize + `\p{M}`-strip path, identical to the reference.
- Benchmarks were measured on a shared-CPU VM with noticeable variance; expect
  the same ~3× ratio in the heat, not the same absolute milliseconds.
- `main.ts` keeps only the house `--no-incremental-marking` flag; extra V8
  flags (`--max-semi-space-size`) showed no reliable gain here and were left out.

## Local git

- Code commit (all entry files incl. this HANDOFF): `__CODE_SHA__`
- HEAD after recording the sha above: see `git log` (the following commit only
  fills in the sha line in this file).
