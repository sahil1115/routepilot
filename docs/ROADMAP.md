# RoutePilot — Roadmap

Implementation is **strictly incremental**. Each phase is a hard gate.

**Rules**

1. Implement only the requested phase.
2. Validate it completely (`npm run verify`).
3. Report findings, changed files and gate results.
4. Stop. Do not begin the next phase without explicit instruction.
5. Never proceed while a previous phase is broken. Any failure that is genuinely
   an external/environment limitation must be documented as such, not hidden.

**Gate command for every phase**

```
npm run verify   # typecheck -> lint -> format:check -> test -> build
```

---

## Phase status

Numbering follows the specification's phases, which is what has been
implemented against. Earlier revisions of this table used a different numbering
and had drifted out of step with the code; it was corrected in Phase 9.

| Phase | Name                                 | Status                    |
| ----- | ------------------------------------ | ------------------------- |
| 0     | Baseline                             | **Complete**              |
| 1     | Domain model + model registry        | **Complete**              |
| 2     | Task + repository intelligence       | **Complete**              |
| 3     | Constraint filter + static router    | **Complete**              |
| 4     | CLI (cost model + budgets folded in) | **Complete**              |
| 5     | Agent adapters                       | **Complete (unverified)** |
| 6     | Execution monitor + failure taxonomy | **Complete**              |
| 7     | Escalation graph + context handoff   | **Complete**              |
| 8     | Outcome model + local telemetry      | **Complete**              |
| 9     | Expected cost to success             | **Complete**              |
| 10    | Learning (P(success) online)         | **Complete**              |
| 11    | Calibration + safeguards             | **Complete**              |
| 12    | Shadow policy                        | **Complete**              |
| 13    | Contextual bandit + safe exploration | **Complete**              |
| 14    | VS Code extension                    | **Complete (unverified)** |
| 15    | End-to-end scenarios + task runner   | **Complete**              |
| 16    | Performance                          | **Complete**              |
| 17    | Documentation                        | **Complete**              |
| 18    | Final quality gate                   | **Complete**              |
| 19    | Development behaviour                | **Complete**              |
| 20    | MVP scope audit                      | **Complete**              |
| 21    | MVP milestone — `routepilot run`     | **Complete**              |
| 22    | Closing the loop — record and learn  | **Complete**              |
| 23    | Re-inspection and plan               | **Complete**              |
| 24    | Validation configuration             | Next                      |
| 25    | Offline policy evaluation            | Not started               |

Phases 10 and 11 of the _original_ roadmap (validation engine, telemetry schema)
were folded into Phases 6 and 8 respectively and are complete. Roadmap Phase 12
(learning engine) was delivered as specification Phase 10 and is complete;
contextual bandits remain explicitly out of scope.

**"Complete (unverified)" is not "working."** The agent adapters are built and
tested against mocks, but no adapter has been run against a real installed tool,
so none is marked supported (spec section 2, rule 20). See `src/adapters/verification.ts`.

---

## Phase 0 — Baseline (complete)

**Goal:** know exactly what exists, and make the validation gates real.

- Inspect repository; identify existing architecture (result: none — greenfield).
- Establish the toolchain: TypeScript, Vitest, ESLint, Prettier, build scripts.
- Record the baseline in [ARCHITECTURE.md](./ARCHITECTURE.md).
- Create architecture and roadmap docs.

**Explicitly out of scope:** every RoutePilot component. No `ModelRegistry`, no
routing engine, no adapters, no CLI.

**Validation:** project builds, typechecks, lints and tests clean; no unrelated
files changed.

---

## Phase 1 — Domain model + configuration (complete)

**Goal:** provider-neutral types and validated, configuration-driven models.

Delivered:

- `ModelSpec`, `ProviderSpec`, `AgentAdapter`, `TaskType`, `FailureType`,
  eligibility types. `RoutingFeatures`, `RoutingDecision` and `Outcome` were
  deferred to the phases that define them, rather than designed speculatively.
- `ModelRegistry` / `ProviderRegistry` loaded from configuration, with a hard
  eligibility filter that reports a reason for every exclusion.
- Configuration schema with safe defaults, cross-field validation and
  actionable errors (spec section 47).
- Strength/language values stored under `priors`, structurally separate from
  observation. A `ModelSpec` has nowhere to record a sample count
  (spec section 39).
- Token pricing arithmetic. Expected-cost modelling stays in Phase 4.
- CLI: `models` (with eligibility filters), `providers`, `config validate`.

**Done when:** a model set can be defined purely in configuration, invalid
configuration produces an actionable error, and no vendor name appears in core
source. — All satisfied; vendor neutrality is enforced by a test.

---

## Phase 2 — Task + repository understanding (complete)

Delivered:

- `TaskClassifier` over the spec section 9 categories, combining keyword,
  active-file, referenced-file, working-tree and diagnostic evidence. Every
  point of score is attributable to a named rule.
- `RepositoryAnalyzer` with levels 1 (bounded walk plus manifests and git),
  2 (relevant files, dependencies, tests, diagnostics, context) and 3 (an
  approximate import graph). One cached file inventory is shared by all three.
- `FeatureExtractor` producing the spec section 11 feature set. Execution
  features are deliberately absent until Phase 8.
- `AnalysisCache` with component-wise fingerprinting and **partial**
  invalidation: modifying a file keeps the inventory, adding one rebuilds it.
- Ports (`FileSystemPort`, `GitPort`, `DiagnosticsPort`) in core, with Node
  implementations in `src/infra`.
- CLI `analyze`, which chooses its own analysis level from the task.

**Done when:** L1 is cheap and always runs; L2/L3 only when warranted;
classification tested against fixtures. — All satisfied. The acceptance
criterion is asserted against counted filesystem calls: a warm level-3 analysis
of this repository performs 0 directory reads versus 12 cold, and 0 file reads
versus 58.

---

## Phase 3 — Constraint filter + static router (complete)

Delivered:

- `ConstraintEngine` with per-task capability derivation, so a model without
  tools is excluded from work that edits files and _not_ from work that only
  reads. Every exclusion carries a reason (spec section 12).
- `SuccessPredictor`: static, interpretable priors —
  `failure = (1 − capability) × difficulty`. Falls back to a tier default when a
  model declares no prior, and reports that it did.
- `CostEstimator`: initial, retry, escalation and **expected total cost to
  success**, with escalation targets resolved among the candidates
  (spec section 15).
- `RiskEstimator`: how risky this _model_ is for this _task_, distinct from how
  dangerous the task is.
- `RoutingEngine`: minimises expected cost to success subject to confidence,
  risk, latency and budget. Honours explicit model requests; never exceeds a
  budget silently (spec section 16).
- `explainDecision`: every candidate's numbers, every exclusion's reason, and
  the policy in force (spec section 50).
- CLI `route`, and `toRoutingPolicy` mapping configuration to policy.

**Done when:** an impossible model can never be selected, and every decision
explains itself including why candidates were excluded. — Both satisfied. All
eight specified cases pass, and determinism is asserted against registration
order, repeated calls, floating-point noise and the absence of clock or
randomness in the routing sources.

---

## Phase 4 — CLI (complete)

The cost model and budget work originally planned here landed in Phase 3, because
routing case 8 could not be tested without it. Phase 4 was therefore run as the
**CLI** phase.

Delivered:

- `routepilot status` — configuration, providers, policy, budgets, features and
  a capability table that names the phase each unavailable command is waiting
  for. Reports whether a provider's credential environment variable is **set**,
  never its value.
- A documented **exit-code contract** (`src/cli/exit-codes.ts`): `0` success,
  `1` error, `2` usage, `3` routing declined. The last is distinct so a script
  can tell "nothing is broken, the router said no" from "the tool failed".
- `route` output restructured into labelled sections: decision, a dedicated
  **estimated cost** block, a candidate table with per-candidate status, an
  exclusion table, and the policy in force. `--explain` adds the core's
  provider-neutral explanation.
- `run`, `history` and `evaluate` are recognised and answered with what they
  need, instead of falling through to "unknown command".
- Shared `src/cli/format.ts` (tables, money, percentages, durations) and a
  reusable CLI test harness in `src/test-support/cli-harness.ts`.

**Done when:** RoutePilot can operate without VS Code. — Satisfied. Every
validation item is reachable from a terminal, verified against the built binary.

Still outstanding for a future budget phase: session / daily / monthly budgets
are validated and displayed but not yet **enforced** (only `request` is), and
estimated-vs-actual cost observability needs the telemetry store (Phase 11).

---

## Phase 5 — Agent adapters (complete, but unverified)

Phases 6 and 7 were folded in here: the user's Phase 5 instruction was
"Claude Code adapter, then Cursor CLI adapter, then generic direct provider".

Delivered:

- `runProcess` — shared child-process execution: **never a shell**, bounded by
  timeout and output cap, cancellable, streaming stdout line by line.
- `ClaudeCodeAdapter` — wraps the documented `claude -p ... --output-format
stream-json` surface (spec section 18). No interception, no modification of
  internals.
- `CursorCliAdapter` — wraps the documented `cursor-agent` CLI
  (spec section 19), with an actionable setup error when absent.
- `DirectProviderAdapter` — generic HTTP transport with configurable endpoint,
  auth, timeout, retry and credential redaction; vendor request/response
  shapes supplied per provider by a `ProviderProtocol` (spec section 20).
- `FakeAgentAdapter` — scriptable, for deterministic testing.
- `AgentRegistry` — selection, bounded retry with backoff, and fallback to
  another adapter. Neither retry nor fallback ever concludes `MODEL_WEAKNESS`.
- `ADAPTER_VERIFICATION` — a machine-checked honesty mechanism, plus
  `npm run verify:adapters -- <id>` for real-execution verification.

**Status: no adapter that talks to an external tool is verified.**
Availability detection for Claude Code _was_ confirmed against a real
install (v2.1.72). Execution, streaming and the event schema were not:
Claude Code refuses to run nested inside a Claude Code session, and
`cursor-agent` is not installed here. Both are covered only by stub-process
tests, which prove the adapters handle the shapes they were told to expect —
not that those are the shapes the tools emit.

**Done when:** an adapter has been run against its real tool and the evidence
recorded in `src/adapters/verification.ts`. Not yet done.

---

## Phase 6 — Execution monitor + failure taxonomy (complete)

Run as the user's Phase 6; the validation engine from roadmap Phase 10 was
folded in, since classification depends on knowing whether validation passed.

Delivered:

- `ExecutionMonitor` — accumulates `ExecutionSignals` from the normalised event
  stream: tool calls and failures, longest consecutive-failure run, terminal
  commands, edit churn per file, errors, cancellation, time without progress.
  **An assistant message is not progress**; only a successful tool result, a
  file change or a completed command is.
- `StruggleMonitor` — multi-signal weighted score, never a single threshold.
  Reports `score` (how badly it is going) **and** `modelAttributableScore` (how
  much implicates the model). Escalation is keyed to the second.
- `FailureClassifier` — the full spec section 22 taxonomy. Environmental causes
  win; `MODEL_WEAKNESS` requires positive evidence and is never a default.
- `ValidationEngine` — plans checks from the task (spec section 30), runs them
  after execution, and reports a check with no command as **not run**
  (`passed: null`), distinct from passing and from failing.
- `CommandRunnerPort` + `NodeCommandRunner`, and `commandsFromPackageScripts`,
  which uses only scripts a repository actually declares.

All ten required scenarios classify correctly, and the look-alike pairs come
apart: a model-broken test suite versus one broken by an unreachable database;
a build the model broke versus one already failing.

---

## Phase 7 — Escalation graph + context handoff (complete)

Delivered:

- `EscalationEngine` — a **graph**, not a ladder. The failure classification
  drives the decision, and only `MODEL_WEAKNESS` leads to a stronger model
  (spec sections 24 and 26). Eight actions: `none`, `retry`, `improve-context`,
  `escalate-vertical`, `escalate-horizontal`, `provider-fallback`, `ask-user`,
  `stop`.
- **Horizontal escalation** — moves sideways when a same-tier model is markedly
  better at _this_ task's primary skill, rather than always paying more.
- **Provider fallback** — retries first, then a comparable model from another
  provider, keeping the model class unchanged.
- **Limits** — escalations, retries, total cost and elapsed time, checked
  _before_ any rule, so a task can never loop (spec section 27). A termination
  test drives the graph and asserts it stops.
- `ContextHandoffBuilder` — a compact briefing, never a transcript
  (spec section 28): workspace state, files changed and inspected, failing
  checks, approaches already tried, and an explicit instruction not to repeat
  them.

All eight specified cases pass. Only one of them ends in a stronger model —
which is the point.

---

## Phase 8 — Outcome model + local telemetry (complete)

Roadmap Phases 10 and 11 folded together: an outcome model with nowhere to
persist it, or a store with nothing to record, would each be half a phase.

Delivered:

- `OutcomeRecorder` — multi-dimensional `TaskSuccessScore` over syntax, lint,
  build, tests, task criteria and user acceptance. Weights renormalise over the
  dimensions actually evaluated, and `evidence` reports how much of the possible
  evidence backed the score (spec section 31).
- User signals (spec section 32), with cancellation deliberately **not** counted
  as a negative signal about the model.
- `SqliteTelemetryStore` over `node:sqlite` — no native dependency. Records
  requests, routing decisions and candidates, attempts, events, escalations,
  outcomes and user signals.
- Forward-only migrations tracked by SQLite's `user_version`.
- **Corruption fallback**: an unreadable database is quarantined to
  `*.corrupt-<timestamp>` and a fresh one started; routing is unaffected.
- **Redaction at the boundary** (spec section 34): credential shapes and
  absolute paths are stripped from every string before it reaches disk.
- `NullTelemetryStore` — telemetry can be switched off entirely, and the driver
  is then never even imported.

**Verified against the real database file**, not just in-process: a recorded
attempt whose error text contained both an API key and an absolute path yields a
file on disk containing neither, while keeping the file name that made the
record useful.

---

## Phase 9 — Expected cost to success (complete)

The product's thesis, made explicit and testable. A cost model existed from
Phase 4; this phase extracted it, named every term, and proved the claim it
rests on.

Delivered:

- `src/core/routing/expected-cost.ts` — the arithmetic as a **pure function**,
  with no dependency on a registry, a model or a task:

  ```
  expectedTotal(m) = initial(m) + P(fail | m) x recovery(m)
  recovery(m)      = retryShare x retry(m) + escalationShare x escalation(m)
  escalation(m)    = expectedTotal(next) x (1 + handoffOverhead)
  ```

- `CostProjection` extended with `failureProbability` and `recovery`, so all
  five quantities are first-class and auditable rather than intermediate values
  that vanish.
- `cost-estimator.ts` rewired onto the shared function — one implementation of
  the model, not two that can drift.
- `breakevenInitialCost()` — the first-attempt price above which a cheaper
  sticker price is a trap. Exposed so the boundary can be asserted and
  explained, instead of being an emergent property nobody can point at.
- Input validation: a negative cost or an out-of-range probability throws
  rather than producing a plausible-looking wrong number.

**The required scenario, proven rather than asserted.** `acme/thrifty-1` has the
cheaper first attempt (0.1229 vs 0.1351 USD) and the dearer expected path
(0.1418 vs 0.1365 USD); the router selects `acme/steady-1`. Critically, the
cheaper model is **fully viable** — it clears the confidence threshold, the risk
cap, the latency cap and the budget — so the confidence filter is demonstrably
not what decided it. The result holds with the threshold dropped to 0.1.

**The contrasting case is recorded, not hidden.** When a model is _much_ cheaper
(`acme/bargain-1`, ~6x), trying it first genuinely is the lower expected cost
even at the same mediocre success rate, and the router correctly opens with it.
Cheapest-initial and cheapest-expected diverge when two models are close in
price and differ in reliability — roughly when the cheaper one costs more than
85-90% of the dearer. This is precisely why `minimumSuccessProbability` is a
**separate** constraint: expected dollars alone would always gamble, and dollars
are not the only cost of a failure.

Not done in this phase: the recovery shares are still deterministic priors
(`retryShare` 0.35, `handoffOverhead` 0.2). Replacing them with observed rates
is Phase 12's job, and the failure classifier from Phase 6 already distinguishes
the cases they average over.

---

## Phase 10 — Learning: P(success | features, model) (complete)

Delivered the roadmap's learning engine, at the scope the specification's
Phase 10 sets: an online success predictor, no contextual bandits.

Delivered:

- `src/core/learning/beta-model.ts` — Beta-Bernoulli shrinkage as a **pure
  function**. A prior is treated as `strength` pseudo-observations (default 12);
  real observations are added to those. Zero observations returns the prior
  _exactly_ (short-circuited, because `(12 x 0.8) / 12` is not 0.8 in floating
  point and the backoff chain would compound that error).
- `src/core/learning/success-model.ts` — `LearnedSuccessModel`. Observations are
  stored per `(model, taskType, scope)` and read back as a three-level chain,
  each level shrunk toward the one above.
- **The levels partition the data; they do not nest.** Each level counts only
  what the deeper levels exclude, so every observation enters the chain exactly
  once and the three level counts sum to the model's total. Nesting them would
  feed the same evidence through the shrinkage three times.
- Migration v3: `learned_success`, holding a model id, two enumerated values and
  three numbers. No prompt, path or source text can reach it.
- Wired into `routepilot route`, with the store opened only when learning is
  enabled.

**Sample counts are real counts.** The prior's pseudo-observations exist only
inside the arithmetic and are never reported as data (spec section 2, rule 11).
`shrinkToPrior` rejects a non-integer observation count outright — a fractional
sample count is the shape a fabricated one would take.

**Priors stay in charge until the evidence earns its place.** Below
`minimumTrainingSamples` the configured prior is returned untouched and the
count is still reported honestly; with learning disabled, no decision changes at
all. Even once learning applies, the prior still anchors the estimate.

**Acceptance, measured against ground truth.** Two models carry deliberately
misleading priors: `acme/flatters-1` declares 0.96 and truly succeeds 30% of the
time; `acme/modest-1` declares 0.74 and truly succeeds 95%. Static routing picks
`flatters` — it looks better _and_ costs less per attempt, so nothing in the
Phase 9 machinery can catch the error. After 200 deterministic observations each,
routing reverses to `modest`, cutting the true expected cost to success from
**0.24191 to 0.15697 USD, a 35% reduction**.

Not done: no time decay (a clock in the estimate path would make decisions
depend on when they were made), no exploration, and an escalated task teaches
nothing because there is no honest way to attribute it to one model.

---

## Phase 11 — Calibration and safeguards (complete)

Phase 10 made RoutePilot able to learn a success probability. This phase asks
whether that number can be believed, and switches learning off when it cannot.

Delivered:

- `src/core/calibration/metrics.ts` — Brier score, its Murphy decomposition
  (reliability / resolution / uncertainty), expected and maximum calibration
  error, signed bias, Brier skill score, and the reliability diagram. Pure
  functions over `(predicted, actual)` pairs.
- **The decomposition is checked, not assumed.** `BS = reliability - resolution
  - uncertainty`holds exactly only when predictions are constant within a bin;`decompositionResidual` reports the leftover instead of hiding it. It is
    ~1e-16 on every fixture.
- `src/core/calibration/gate.ts` — the safeguard. **Three states, not two**:
  `trusted`, `unassessed` (too few predictions to judge — absent is not zero
  applied to calibration itself), and `distrusted`.
- `src/core/calibration/tracking.ts` — pairs a decision's prediction with the
  outcome it produced, refusing to attribute an escalated or unevaluated task.
- Migration **v4**: `predictions`, holding the individual pairs a reliability
  diagram needs. Learned estimates and priors are scored **separately**, because
  pooling them lets good priors disguise bad learning.
- `routepilot calibration` — the reliability table, the metrics with their
  direction of "better" stated, and which threshold failed by how much.

**The default is "distrust on evidence", not "prove it first".** Requiring proof
before activation deadlocks: predictions only accumulate while learning is
active. `requireCalibration` gives the conservative behaviour where the cost of
a wrong route justifies it.

**Four ways to fail, because one metric cannot catch them all.** ECE, worst-bin
error, skill score, and signed over-confidence. The skill floor sits
deliberately **above zero**: a predictor answering the base rate to everything
scores exactly 0 skill with perfect calibration, and applying it would replace
the models' differentiated priors with one flat number.

Verified against the built binary: a store seeded with over-confident
predictions produces `DISTRUSTED (withdrawn, priors restored)`, routing reverts
to the static choice, and the candidates table shows `80 runs (prior: 56%)` —
the data reported honestly and not used.

Not done: no recalibration (a distrusted predictor is withdrawn, never
corrected), and calibration is measured over a selected sample — only the model
that ran has an outcome.

---

## Phase 12 — Shadow policy (complete)

Evaluates alternative routing policies alongside the live one and records what
they would have chosen. **No shadow policy executes anything.**

Delivered:

- `src/core/shadow/shadow-router.ts` — `ShadowRouter.compare()` returns the live
  decision plus one outcome per shadow policy.
- `src/core/shadow/selection.ts` — the three selection rules. Every rule chooses
  only among **viable** candidates, so a shadow never proposes a route the live
  policy would have been forbidden to take.
- Three standing baselines (spec section 42): `priors-only` (is learning
  changing anything?), `cheapest-first` (the policy RoutePilot claims to beat),
  and `strongest-first` (the spending upper bound).
- `src/core/shadow/agreement.ts` — agreement rate, divergent choices, and a
  summed cost delta that carries its own comparable count.
- Migration **v5**: `shadow_decisions`.
- `routepilot shadow`, and a divergence section in `routepilot route` shown only
  when a policy actually disagrees.

**The non-execution guarantee is structural, not a convention.** `ShadowRouter`
is constructed from a model registry and a learned model; neither can start a
process. No adapter is reachable from `src/core` at all — the architectural
guard fails the build on any such import. A `ShadowOutcome` carries a model
**id**, so there is no session a caller could run by mistake.

**Validated as the specification states it.** In
`src/adapters/shadow-execution.test.ts` the live policy selects
`acme/fast-1`, `strongest-first` selects `acme/deep-1`, and the executing
adapter's recorded `(request, model)` list is exactly `['acme/fast-1']`.
Evaluating more shadow policies adds no adapter calls.

**What a shadow comparison cannot tell you.** The shadow's model was never run,
so no outcome exists for it, and both sides of every cost delta come from the
same success probabilities — a miscalibrated predictor shifts them together
rather than being revealed. The report never uses the word "saving" where it
carries a figure, and states the limitation in full (spec section 44).
Establishing that one policy is actually better needs outcomes for both arms,
which is Phase 13.

---

## Phase 13 — Contextual bandit and safe exploration (complete)

Chooses between exploiting the model believed best and **exploring** a different
one to find out whether it is better. Off by default, and refused outright on
any task where a failed experiment is not something to shrug at.

Delivered:

- `src/core/bandit/uncertainty.ts` — Beta posterior width and an upper
  confidence bound. **Not Thompson sampling**: determinism has been a hard
  requirement since Phase 3, and architectural principle 9 forbids randomly
  selecting an expensive model. UCB gives the same optimism deterministically.
- `src/core/bandit/exploration-gate.ts` — the safety gate. Every block is hard;
  no combination of favourable conditions overrides one.
- `src/core/bandit/explorer.ts` — candidate selection by **optimistic expected
  cost**, so uncertainty alone never justifies spending. Only _viable_
  candidates are considered: exploration widens which acceptable model is
  chosen, never what counts as acceptable.
- `TaskHazard` surfaced from the classifier. The risk patterns already detected
  `destructive`, `production`, `security` and the rest; they were summed into a
  scalar and the labels discarded. A score cannot answer "is this destructive?",
  so the gate matches the hazard itself.
- `--mode normal|production|critical`, defaulting to **production**. A caller
  that has not said where it is running gets the cautious reading, so forgetting
  the flag can only ever suppress an experiment.

**Exploration never occurs when** the task is high risk, the budget disallows
it, a model was explicitly requested, the mode is production or critical, or the
task carries a hazard — plus two prerequisites: enough observations exist, and
the calibration safeguard still trusts the predictor.

**A real bug the simulation caught.** The first implementation compared each
alternative's _optimistic_ cost against the exploit choice's _expected_ cost.
That asymmetry starves whichever arm is currently preferred: it receives no
benefit of the doubt, so something always looks plausibly better, so it is never
run again and its estimate freezes. One arm sat at five observations for three
hundred rounds while the other was "explored" every single time. Scoring every
candidate optimistically — standard UCB — fixed it.

**Simulation result**, 300 tasks, arms with known true rates:

| policy           | total cost | successes   | final choice   | experiments |
| ---------------- | ---------- | ----------- | -------------- | ----------- |
| exploit only     | 44.57      | 270/300     | the worse arm  | 0           |
| with exploration | **27.91**  | **293/300** | the better arm | 5           |

37% cheaper, and exploration stopped after round 9 — five experiments out of
three hundred tasks. Stable across optimism 1 to 2.5.

Not done: no per-context exploration budget, no decay, and the bandit is not
contextual in the full sense — it uses the learned per-(model, task, scope)
estimates but does not fit a model across features.

---

## Phase 15 — End-to-end scenarios and the task runner (complete)

Fourteen complete scenarios, each driven through the whole pipeline. Four of
them — escalation on model weakness, an environment failure, a provider outage,
a user cancellation — describe execution flows, and **nothing existed that ran
one**. So this phase also built the orchestrator that every phase since 5 had
been noting the absence of.

Delivered:

- `src/core/run/task-runner.ts` — `TaskRunner`, joining
  route → execute → monitor → validate → classify → escalate → score → learn.
  No new machinery: every stage already existed and was already tested alone.
- `src/core/types/run.ts` — `ExecutorPort`, so `src/core` still cannot see an
  adapter and the whole pipeline can be driven by a scripted executor.
- `src/adapters/executor.ts` — `RegistryExecutor`, the port over the agent
  registry.
- `AgentRegistry` gained an `onEvent` hook. It consumed the event stream and
  discarded it, which silently disabled the execution monitor.
- `src/e2e/scenarios.test.ts` — the fourteen scenarios, **51 assertions**.

**The three routing scenarios pass on the specification's own wording**, with no
tier rule anywhere: "Rename this variable." → cheap, "Add a standard REST
endpoint." → medium, "Refactor authentication across the repository." →
frontier. Each is reached through expected cost and the confidence threshold.

**The failure taxonomy is what keeps escalation honest.** A database outage
classifies as `ENVIRONMENT_FAILURE` and escalates to nothing — buying a stronger
model would not start a database. A cancelled run classifies as `USER_CANCELLED`
and records no observation at all.

**One defect found by the scenarios**: a failed run recorded `score: null,
evidence: 0`, because validation results were only carried into the outcome on
success. A run whose tests demonstrably failed was being reported as "not
evaluated".

Not done: no `routepilot run` command. The runner is exercised end to end
against scripted executors, but no adapter has been verified against its real
tool, so exposing one would ship an unverified path.

---

## Phase 16 — Performance (complete)

Measured first, optimised second. Full report in `docs/PERFORMANCE.md`;
`npm run bench` reproduces it.

**The finding that shaped the phase:** everything RoutePilot computes is free.
Feature extraction and routing together take **under half a millisecond**, and a
warm analysis does **zero** filesystem work. The entire cost of a routing pass is
one `git` subprocess at 180-350 ms, which cannot be skipped because the cache is
validated against the repository state it reads.

Delivered:

- `src/core/perf/concurrency.ts` — bounded, order-preserving concurrent mapping.
  Applied to the inventory walk, level 3's source reads, and the fingerprint's
  manifest probes. Measured `readFile` 47 ms -> 11 ms, `stat` 22 ms -> 3 ms.
- `AnalysisRequest.gitState` — `analyzeTask` analysed twice and spawned `git`
  twice. Reading it once cut the rename pass **573 ms -> 319 ms**.
- `AnalyzeOptions.analyzer` — the analyzer, and with it the cache, was rebuilt on
  every call, so nothing was cached between requests. The VS Code extension now
  keeps one per workspace root.
- `StageTimings` on every `RouteResult`, so the four tracked stages are
  observable in production and not only in a benchmark.
- `bench/benchmark.mjs` and `npm run bench`. It asserts **no threshold**: the
  specification warns against chasing an absolute, and a benchmark that fails on
  a busy laptop teaches nothing.
- `analysis-performance.test.ts` — the properties asserted in **operation
  counts** rather than durations, so a reintroduced sequential loop fails the
  build.

**An optimisation measured and rejected.** Collapsing `NodeGit`'s two spawn
rounds into one looked obviously better and benchmarked **slower** (279 ms
against 178 ms): process creation is the bottleneck, so five concurrent spawns
contend where four plus one do not. `NodeGit` was left alone.

**Result:** routing overhead is 0.04%-3.7% of RoutePilot's own estimate of model
execution, depending on task size.

---

## Phase 17 — Documentation (complete)

Twelve documents, written to be accurate rather than flattering. Every one ends
with a limitations section, and a test enforces that.

Delivered:

- `docs/CONFIGURATION.md`, `docs/INTEGRATIONS.md`, `docs/CLAUDE_CODE.md`,
  `docs/CURSOR.md`, `docs/ESCALATION.md`, `docs/LEARNING.md`,
  `docs/EVALUATION.md`, `docs/PRIVACY.md`, `docs/SECURITY.md` — new.
- `README.md` rewritten. The status block now leads with what RoutePilot
  **cannot** do: no verified adapter, no `run` command, an extension never
  opened in VS Code.
- `docs/ARCHITECTURE.md` de-staled. Section 2 was headed "Target architecture
  (not yet implemented)" and 2.4 "Key interfaces (shape only — not yet
  written)"; both had been true in Phase 0 and false for a dozen phases since.
  Kept as the statement of intent with the mapping added, so the difference
  between what was planned and what was built stays visible.
- `config/README.md` reduced to a pointer, so there is one configuration
  reference rather than two that can disagree.
- `src/docs.test.ts` — documentation guards.

**The guards are the part that will still be working in six months.** Every
internal link is resolved (40 of them); every required document must exist and
be substantial; the README must still say no adapter is verified; the extension
document must still say it has never run in VS Code; and every document
describing budgets must still name the scopes that are not enforced. The
limitations-section check found a real gap in `CURSOR.md` immediately.

---

## Phase 18 — Final quality gate (complete)

Everything run, and every checklist item mapped to the evidence that proves it.
Reproduce with `npm run gate`.

**Gates: 7/7 passing.** Typecheck, lint, format, 1215 tests across 49 files,
build, `npm audit` (0 vulnerabilities, one runtime dependency), and the
extension's 19 fake-host checks.

**Checklist: 21 pass, 2 partial, 2 cannot verify, 0 broken.**

| verdict       | items                                                                              |
| ------------- | ---------------------------------------------------------------------------------- |
| PARTIAL       | budget enforcement (only `request` is applied); VS Code extension (fake host only) |
| CANNOT VERIFY | Claude Code adapter; Cursor adapter                                                |

All four trace to one root cause: **nothing has ever been executed against a
real model.**

`scripts/quality-gate.mjs` re-derives every tick from the test suite rather than
recording a human's judgement at a moment. An item whose evidence has been
renamed or deleted reports **BROKEN**, which is louder than a silent pass — and
it immediately caught five of the author's own probes pointing at test names
that did not exist.

**One bug found by the gate, in the gate.** The first version spawned `npx.cmd`
with `shell: false` and every gate reported FAIL — the exact Windows `.cmd`
limitation documented in Phase 5. Enabling a shell would have contradicted
`docs/SECURITY.md`, so it does what the Claude Code adapter does and invokes the
JavaScript entry points through `node` directly.

**One hardening change.** `SqliteTelemetryStore.statistics()` interpolated a
table name into SQL from a `string` parameter. Every call site passed a literal,
so it was safe — but a table name cannot be a bound parameter, and `string` is a
footgun for the next person. Narrowed to a closed union, so the compiler now
guarantees it.

---

## Phase 19 — Development behaviour (complete)

Specification section 72: the ten-step phase loop, mechanized as `npm run phase`
(`scripts/phase-check.mjs`). Steps 1-5 are run; steps 6-9 are checked against the
evidence each leaves behind; step 10 is the verdict. Documented in
[DEVELOPMENT.md](DEVELOPMENT.md).

Running it exposed two problems.

**Step 5 had been vacuous for eighteen phases.** This repository has no commits,
so every file is untracked and `git diff` exits 0 printing nothing. Any loop
that shells out and checks the exit code reports the step green while inspecting
a void. `npm run phase` now fails the step and says why; it does not fix it by
committing, because principle 13 forbids that.

**`GitState` conflated "not measured" with "zero".** `NodeGit` substituted empty
output for a _failed_ sub-query, so a `git status` that timed out produced
`changedFiles: []` and `+0/-0` — indistinguishable from a repository read
successfully and found clean. This is the project's own "absent is not zero"
rule, broken in the layer that feeds every routing decision. Fixed structurally:
those fields are now nullable through `GitState`, `AnalysisLevel1` and the
feature vector, and the fingerprint tags both branches so an unreadable tree can
never reuse a cached clean-tree analysis.

Also added `src/source-hygiene.test.ts`, which fails the build on stray control
characters in source. It found two.

---

## Phase 20 — MVP scope audit (complete)

Specification section 73: do not overengineer the MVP. The spine
`TASK -> ROUTING -> MODEL -> EXECUTION -> MONITORING -> ESCALATION -> OUTCOME`
must be proved first, and eight things must not be begun with.

That instruction arrived after most of the "later phases" had been built, so it
could not be followed as a build order. It was audited instead, in
`src/e2e/mvp-spine.test.ts`: eleven tests that run the entire spine with
learning, exploration, the bandit, shadow routing and telemetry all switched
off, and that check the eight-item exclusion list against the tree.

**Result: the spine works with everything switched off.** The advanced
machinery is an addition to a working core, not part of it. All eight excluded
items are absent or off by default; the runtime dependency tree is one package.

No feature was added. Section 73 asks for less, and the honest response to it
was a proof rather than a build.

---

## Phase 21 — MVP milestone (complete)

Specification section 74: fourteen capabilities the first working milestone must
support. Thirteen were already built. The fourteenth, "one real agent adapter",
had been outstanding since Phase 5 — and what was missing was never the adapter.
It was a production caller.

**New: `routepilot run`.** `TaskRunner`, `AgentRegistry` and `RegistryExecutor`
had no caller outside the test suite, so the entire execution half of RoutePilot
was unreachable from the product. `src/adapters/build.ts` probes the buildable
adapters and `src/cli/run.ts` drives the spine end to end.

**It plans by default.** `--execute` is a deliberate act, because no adapter has
been verified against its real tool and a mistyped command should not be able to
hand a coding agent write access to a repository. The caution is expressed in
the default rather than by withholding the command.

**It refuses rather than guessing**: no model selected, no adapter available, an
unknown adapter id, or — new in this phase — an attempt to launch the very agent
it is running inside. Claude Code nested in Claude Code crashes every active
session; `scripts/verify-adapter.mjs` has refused that since Phase 5, and `run`
reaches the same binary by a different path.

`src/e2e/mvp-milestone.test.ts` audits all fourteen items against the code.

**Still true: no adapter has been executed against its real tool.** `run` makes
that possible from a plain terminal. It does not make it done.

---

## Phase 22 — Closing the loop (complete)

Specification section 75 ends with two steps that had never happened: _after
completion, record_; _later, learn from the result_. Every record type had
existed since Phase 8 and the learning layer since Phase 10, but nothing
produced a record from a real run — the store was written to only by its own
tests.

**New: `src/telemetry/recorder.ts`.** The producer. A completed run becomes a
request, a routing decision with its candidates, one row per attempt, one per
escalation, and an outcome. Wired into `routepilot run --execute`.

**Three facts were being computed and discarded**, and would otherwise have been
recorded as fabricated zeros: the per-dimension validation signals, the adapter
that ran each attempt, and the struggle assessment. All three are now carried
out on `RunResult` and `RunAttempt` rather than invented at the recorder.

**The finding.** `routepilot run` configures no validation commands — there is no
configuration surface for them — so a run finishes _unevaluated_, and
`observationFromOutcome` correctly refuses to learn from it. Section 75's loop
is therefore closed for **recording** and still open for **learning**. That is
asserted as a test rather than left as a footnote, alongside a second test
proving the learn path itself is sound when a run _is_ validated.

Privacy is checked against the bytes on disk: after a real run, the database
file does not contain the prompt.

---

## Phase 23 — Re-inspection and plan (complete)

Specification section 76: inspect the repository, run the baseline, understand
the architecture, produce a plan, update the architecture documentation, and
identify the next phase's changes — without generating a large implementation.

**Baseline:** typecheck, lint, format, build all pass; 1267 tests across 55
files. 123 source files (23,305 lines), 55 test files (16,232 lines), one
runtime dependency.

**Architecture re-verified from the code**, not from the documents: `src/core`
imports no outer layer, contains no vendor name, and the module graph is
acyclic. `docs/ARCHITECTURE.md` §1.4 still described the five-directory Phase 1
tree and has been replaced with the current one; §4 now carries a nine-item plan
derived from the code with an argued sequence.

**A flaky test was chased and fixed.** It failed roughly once in five full-suite
runs, never in isolation, and never the same test twice — always one that drives
the whole route pipeline repeatedly, and always as a timeout rather than a
failed assertion. A per-test timeout had been tried in Phase 22 and was wrong:
it treated the slowest observed victim as the cause. The global `testTimeout` is
now 30s, and that per-test change is reverted.

**Nothing else was implemented.** Section 76 asks for a plan before code.

---

## Phase 25 — Offline policy evaluation

- Policy replay against historical data (spec section 42). The comparison set
  itself is delivered — see Phase 12 — but replay against recorded _outcomes_
  is not.
- Calibration metrics: delivered in Phase 11.
- Shadow routing: delivered in Phase 12.
- No automatic deployment of a learned policy; thresholds must pass first.
- Selection bias documented in reported results (spec section 44).

---

## Phase 14 — VS Code extension (complete, never run in VS Code)

Delivered:

- `src/extension/` — the **pure** layer: view models, the presenter, settings
  resolution and the chat participant's replies. ESM, no `vscode` import,
  covered by the main suite (80 tests).
- `extension/` — a separate CommonJS package holding the shell: activation,
  five commands, the status bar, and the `@routepilot` chat participant. Wiring
  only.
- `extension/scripts/fake-vscode.cjs` and `verify-extension.cjs` — a recording
  fake of the VS Code API and **19 end-to-end checks** against the compiled
  extension.
- `npm run build:extension`, `verify:extension`, `package:extension`.

**The shell is thin on purpose.** The extension host cannot be driven from this
repository's test runner, so anything implemented there ships unverified.
Keeping it to wiring makes the unverified surface small enough to enumerate.

**Two packaging bugs found by testing the artifact rather than the repository.**
The `.vsix` initially shipped without the core at all, and then shipped it
without the nested `{"type":"module"}` marker — so Node read the ESM core as
CommonJS and every `import` was a syntax error. Both worked in the repository
and would have failed for every user.

**Settings narrow, never widen.** A workspace `settings.json` arrives with a
repository, so it may lower a budget, raise a threshold, switch exploration off
and make the mode stricter — never the reverse. Refusals are reported.

**Nobody has installed it and used it.** `docs/EXTENSION.md` carries the
item-by-item verification table, including what remains for a human with VS Code
open.

- `RoutePilot: Run Task` command; optional `@routepilot` chat participant.
- Status display: selected model, escalation marker, running cost.
- Explainability panel: why this model, confidence, estimated vs actual cost,
  failure type.
- Run / cancel / force model / disable escalation / configure budget / view
  history.
- Analysis must never block the UI.

---

## Deferred beyond the MVP

- Contextual bandit routing (learning V4).
- Multi-model ensemble execution — interfaces and docs only (spec section 45).
- Local model providers, judged on observed performance and cost rather than
  assumed to be cheapest (spec section 46).
- Safe exploration, off by default until sufficient data exists, and never on
  destructive, production, security-critical, budget-constrained or
  explicitly-pinned tasks (spec section 40).
