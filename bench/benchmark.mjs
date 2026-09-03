#!/usr/bin/env node
/**
 * RoutePilot performance benchmarks (spec section 69).
 *
 * Tracks the four stages the specification names — repository analysis, feature
 * extraction, routing, and model execution — against a **real repository**
 * rather than a synthetic one.
 *
 * ## What this deliberately does not do
 *
 * It asserts no threshold. The specification is explicit that chasing "under
 * 10ms for everything" is the wrong goal, and a benchmark that fails because a
 * laptop was compiling something teaches nothing. This measures and reports; a
 * human reads the ratio and decides whether it is acceptable.
 *
 * ## The number that matters
 *
 * Routing overhead against the execution it is deciding about. The denominator
 * is RoutePilot's own latency estimate for the model it chose — the same figure
 * the router used to decide — rather than an invented constant, and it is
 * labelled an estimate because that is what it is.
 *
 * Usage:
 *   npm run bench                 # this repository
 *   npm run bench -- <path>       # some other repository
 */

import { performance } from 'node:perf_hooks';
import { argv, exit } from 'node:process';

import { RepositoryAnalyzer } from '../dist/core/analysis/repository-analyzer.js';
import { AnalysisCache } from '../dist/core/analysis/cache.js';
import { NodeFileSystem } from '../dist/infra/node-filesystem.js';
import { NodeGit } from '../dist/infra/node-git.js';
import { analyzeTask } from '../dist/cli/analyze.js';
import { routeTask } from '../dist/cli/route.js';
import { loadConfig } from '../dist/config/load.js';

const root = argv[2] ?? process.cwd();
const REPEATS = 5;

/** Tasks spanning the routing ladder, so the benchmark is not one shape of work. */
const TASKS = [
  { label: 'rename (level 1)', prompt: 'Rename this variable.', level: 1 },
  { label: 'endpoint (level 2)', prompt: 'Add a standard REST endpoint.', level: 2 },
  {
    label: 'refactor (level 3)',
    prompt: 'Refactor authentication across the repository.',
    level: 3,
  },
];

/** Run `fn` `n` times and report the distribution rather than a single number. */
async function sample(n, fn) {
  const times = [];
  for (let i = 0; i < n; i += 1) {
    const started = performance.now();
    await fn(i);
    times.push(performance.now() - started);
  }
  const sorted = [...times].sort((a, b) => a - b);
  return {
    // The median, not the mean: one scheduling hiccup should not define the
    // result, and on a developer machine there is always one.
    median: sorted[Math.floor(sorted.length / 2)],
    min: sorted[0],
    max: sorted[sorted.length - 1],
  };
}

const ms = (value) => `${value.toFixed(1).padStart(7)} ms`;

console.log(`RoutePilot benchmarks — ${root}`);
console.log(`${REPEATS} samples per measurement, median reported.\n`);

// ---------------------------------------------------------------------------
// The fixed floor
// ---------------------------------------------------------------------------

// Measured first, because it sits under every row of the table below. Reading
// that table without it invites the conclusion that caching does not work.
const git = new NodeGit();
const gitCost = await sample(REPEATS, () => git.getState(root));

console.log('Repository analysis');
console.log('  Cold is a fresh cache; warm re-analyses an unchanged repository.');
console.log(
  `  Every row includes one git invocation (median ${gitCost.median.toFixed(0)} ms here,`,
);
console.log(
  `  min ${gitCost.min.toFixed(0)}, max ${gitCost.max.toFixed(0)}), which cannot be skipped: the`,
);
console.log('  cache is validated against repository state, so that state must be read');
console.log('  before the cache can be consulted. The last column subtracts it, and is');
console.log('  the part caching can actually affect.\n');
console.log('  LEVEL           COLD              WARM     WARM MINUS GIT');

for (const level of [1, 2, 3]) {
  const cache = new AnalysisCache();
  const analyzer = new RepositoryAnalyzer({
    fs: new NodeFileSystem(),
    git: new NodeGit(),
    cache,
  });

  const cold = await sample(REPEATS, async () => {
    cache.clear();
    await analyzer.analyze({ root, level });
  });

  await analyzer.analyze({ root, level });
  const warm = await sample(REPEATS, () => analyzer.analyze({ root, level }));

  const withoutGit = Math.max(0, warm.median - gitCost.median);
  console.log(`  level ${level}   ${ms(cold.median)}   ${ms(warm.median)}   ${ms(withoutGit)}`);
}

// ---------------------------------------------------------------------------
// End to end: analysis, feature extraction, routing
// ---------------------------------------------------------------------------

const loaded = await loadConfig({ cwd: root, allowBundledExample: true }).catch(() => null);
if (loaded === null) {
  console.log('\nNo configuration found; skipping the routing benchmarks.');
  exit(0);
}

console.log('\nRouting pass (one analyzer reused across samples, as a long-lived host does)\n');
console.log('  TASK                  ANALYSIS      FEATURES       ROUTING         TOTAL');

const summary = [];

for (const task of TASKS) {
  const analyzer = new RepositoryAnalyzer({ fs: new NodeFileSystem(), git: new NodeGit() });
  await analyzeTask({ prompt: task.prompt, root, level: task.level, analyzer });

  let last;
  await sample(REPEATS, async () => {
    last = await routeTask({
      prompt: task.prompt,
      root,
      level: task.level,
      config: loaded.config,
      analyzer,
      // A generous budget so every task reaches a decision. The benchmark is
      // about how long routing takes, not about which model a budget permits,
      // and a task that selects nothing has no execution estimate to compare
      // against.
      policyOverrides: { requestBudget: 100, minimumSuccessProbability: 0.5 },
    });
  });

  const timings = last.timings;
  console.log(
    `  ${task.label.padEnd(20)}${ms(timings.analysisMs)}  ${ms(timings.featureExtractionMs)}  ` +
      `${ms(timings.routingMs)}  ${ms(timings.totalOverheadMs)}`,
  );

  summary.push({ task, timings, decision: last.decision });
}

// ---------------------------------------------------------------------------
// The ratio the specification actually asks about
// ---------------------------------------------------------------------------

console.log('\nOverhead against model execution\n');
console.log('  TASK                  OVERHEAD   EST. EXECUTION      RATIO');

for (const entry of summary) {
  const selected = entry.decision.selectedModelId;
  if (selected === null) {
    console.log(
      `  ${entry.task.label.padEnd(20)}${ms(entry.timings.totalOverheadMs)}   (no model selected)`,
    );
    continue;
  }

  // The router's own estimate for the model it chose, already computed during
  // the decision. Recomputing it here would risk a different answer and a ratio
  // against a number the router never saw.
  const evaluation = entry.decision.evaluations.find((candidate) => candidate.modelId === selected);
  const estimatedMs = (evaluation?.estimatedLatencySeconds ?? 0) * 1000;
  const ratio = estimatedMs === 0 ? null : entry.timings.totalOverheadMs / estimatedMs;

  console.log(
    `  ${entry.task.label.padEnd(20)}${ms(entry.timings.totalOverheadMs)}   ${ms(estimatedMs)}   ` +
      `${ratio === null ? '     n/a' : `${(ratio * 100).toFixed(2)}%`}`,
  );
}

console.log(
  '\n  Execution time is an estimate, not a measurement: nothing was executed.\n' +
    '  It is the right denominator because it is the same figure the router used\n' +
    '  to decide, but a real run would differ.',
);
console.log(
  '\n  No threshold is asserted. The specification asks that overhead be small\n' +
    '  relative to execution and warns against chasing an absolute target.',
);
