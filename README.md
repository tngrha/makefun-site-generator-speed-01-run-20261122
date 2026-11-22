# makefun-site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/tngrha/makefun-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/tngrha/makefun-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster makefun-site: byte-exact drop-in, ~3.1x faster than the house baseline on the practice set.

## Run it

```sh
node main.ts
```

---

A faster drop-in for makefun-site 1.0.0: `solve.js` exports `run(input)`, which
returns exactly the output tree (path -> text) that makefun-site 1.0.0's `build`
returns for the same input, byte for byte. `main.ts` is the harness driver: it
reads `/input/cases.json`, answers each case alone with `run`, and writes
`/output/answers.json` (with `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` standing
in outside a container).

The implementation follows the makefun-site README spec (front matter, Markdown
subset, template dialect, slug rule, report) with the reference code as the
authority wherever the two differ. Speed comes from structure: bulk HTML
escaping over plain-text ranges, single-pass fused Markdown block rendering,
range-based inline rendering without substring copies, templates compiled to
flat node arrays rendered into a parts array, an ASCII fast path plus per-case
memoisation for slugs and link resolution, and a manual word-count scan.
Nothing is cached between cases.
