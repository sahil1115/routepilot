# Performance

> Routing overhead must be small **compared with model execution** — not small
> against an arbitrary target. This document reports measurements; it asserts no
> threshold, because the specification warns against chasing one.

Run the benchmarks yourself:

```bash
npm run bench                 # this repository
npm run bench -- <path>       # another repository
```

---

## What was measured

On this repository (193 files), median of five samples:

| stage                                    | time                                                |
| ---------------------------------------- | --------------------------------------------------- |
| feature extraction                       | **0.0 – 0.2 ms**                                    |
| routing decision                         | **0.1 – 0.3 ms**                                    |
| repository analysis, warm, excluding git | **0.0 ms**                                          |
| repository analysis, warm, including git | 190 – 220 ms                                        |
| one `git` invocation                     | 180 – 350 ms (min 169, max 973 on a loaded machine) |

Routing overhead against RoutePilot's own estimate of model execution:

| task               | overhead | est. execution | ratio     |
| ------------------ | -------- | -------------- | --------- |
| rename (level 1)   | 399 ms   | 10.8 s         | **3.7%**  |
| endpoint (level 2) | 187 ms   | 415 s          | **0.04%** |
| refactor (level 3) | 360 ms   | 575 s          | **0.06%** |

The execution figure is an estimate — nothing was executed. It is the right
denominator because it is the same number the router used to decide, but a real
run would differ.

---

## The finding that shaped this work

**Everything RoutePilot computes is free. One `git` subprocess is the entire
cost.**

Feature extraction and routing together take under half a millisecond. Warm
analysis does _zero_ filesystem work — the Phase 2 cache eliminates all of it.
What remains is one `git` invocation costing 180–350 ms, and it cannot be
skipped: the cache is validated against repository state, so that state has to
be read before the cache can be consulted.

That reframes the whole phase. There is no point micro-optimising a router that
costs 0.2 ms. The wins available were all about **not paying the git cost twice**
and **not doing filesystem work serially**.

---

## What changed

### 1. Version control is read once per routing pass

`analyzeTask` analysed twice — level 1 to classify, then deeper — and each call
spawned its own `git`. `AnalysisRequest.gitState` lets a caller read it once and
pass it to both.

Measured on the rename task: **573 ms → 319 ms**, a 44% cut in the dominant
cost. Both analyses also now see one consistent view of the working tree.

### 2. Filesystem work is concurrent, bounded, and order-preserving

Three loops did one `await` per file. Measured on this repository:

```
readFile   182 files   sequential 47 ms   concurrency 32   11 ms
stat       182 files   sequential 22 ms   concurrency 32    3 ms
```

`mapWithConcurrency` (`src/core/perf/concurrency.ts`) runs at most 32 operations
in flight — the measured plateau, since 128 was no faster — and **preserves
input order**, so analysis output never depends on which read finished first.

Applied to the inventory walk's `stat` calls, level 3's source reads, and the
fingerprint's manifest probes.

The bound is not a tuning knob so much as the thing that stops a large monorepo
from exhausting its file descriptors.

### 3. A long-lived host reuses its analyzer

`analyzeTask` built a fresh `RepositoryAnalyzer` — and therefore a fresh cache —
on every call, so nothing was ever cached between requests. For the CLI that is
correct; a one-shot process has nothing to reuse. For the VS Code extension it
meant every routing pass re-read an unchanged repository.

`AnalyzeOptions.analyzer` lets a caller supply one. The extension keeps a map
of analyzers keyed by workspace root for the life of the window.

### 4. An optimisation that was measured and rejected

`NodeGit.getState` runs `rev-parse --show-toplevel` and then four commands in
parallel — two spawn rounds. Collapsing to one round looked obviously better:

```
sequential toplevel, then 4 parallel   178  170  396 ms
all 5 in parallel                      279  306  322 ms
```

**Fully parallel was slower.** Process creation is the bottleneck, not latency,
so five concurrent spawns contend where four plus one do not. `NodeGit` was left
alone. Combining `rev-parse --show-toplevel HEAD` into one call was also
rejected: it exits non-zero on a repository with no commits.

---

## What the specification asked for, item by item

| item                             | status                                                                                                                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| cache repository metadata        | Already in place since Phase 2; now **asserted in operations**, not just measured — a warm analysis does zero reads and zero directory walks |
| incrementally update analysis    | Fingerprint-based, component-wise invalidation (Phase 2). Levels survive independently                                                       |
| deeper analysis only when needed | Progressive levels 1–3, chosen from the classified task                                                                                      |
| avoid repeated tokenization      | Token estimation is arithmetic over byte counts — there is no tokenizer to repeat. See `src/core/analysis/tokens.ts`                         |
| avoid repeated AST parsing       | **There is no AST parsing.** Level 3 extracts imports by regex. Nothing to avoid                                                             |
| avoid blocking the VS Code UI    | Routing runs inside `withProgress` with a live cancellation token (Phase 14); the analyzer is now reused so a warm pass does no I/O          |
| basic performance benchmarks     | `npm run bench`                                                                                                                              |
| track the four stages            | `StageTimings` on every `RouteResult`, reported by the benchmark                                                                             |

---

## Honest limitations

1. **These numbers are from one machine, on one repository.** A 193-file
   TypeScript project is not a monorepo. The concurrency wins grow with size and
   the git cost does not, so the ratio should improve — but that is a prediction,
   not a measurement.
2. **The git figure is extremely noisy.** Across runs it ranged 169–973 ms on the
   same machine. Reported medians should be read as an order of magnitude.
3. **Model execution time is estimated, never observed.** No adapter has been
   verified against its real tool, so the denominator in every ratio above is
   RoutePilot's own latency model rather than a stopwatch.
4. **Nothing regression-tests the timings.** The operation counts are asserted in
   `src/core/analysis/analysis-performance.test.ts`; the durations are not, on
   purpose — a wall-clock threshold fails on a busy machine and teaches nothing.
