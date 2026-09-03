# RoutePilot — Architecture

> **Status: Phase 16 complete.** Adapters are unverified against their real
> tools and the VS Code extension has never been run in VS Code — see
> [INTEGRATIONS.md](INTEGRATIONS.md) and [EXTENSION.md](EXTENSION.md).
>
> Section 1 records what the repository contains. Section 2 states the design
> the specification calls for; **it is now built**, and each subsection says
> where. Section 2 was written before implementation and has been kept as the
> statement of intent, with the mapping added rather than rewritten — the
> difference between what was planned and what was built is worth being able to
> see.

RoutePilot is an intelligent coding-agent model router.

**Tagline:** _Choose the cheapest path to success._

Its optimisation target is **expected total cost to successful completion**, not
initial request cost.

---

## 1. Current repository state (factual)

### 1.1 Baseline inspection result

The repository was inspected before any code was written. Findings:

| Question                    | Finding                                                                        |
| --------------------------- | ------------------------------------------------------------------------------ |
| Existing source             | **None.** Directory was completely empty (no files, including hidden ones).    |
| Git repository              | **None** at inspection time. Initialised during Phase 0 (`master`, 0 commits). |
| Language / framework        | None pre-existing                                                              |
| Package manager             | None pre-existing; npm is the only one installed on this machine               |
| Build system                | None pre-existing                                                              |
| Test framework              | None pre-existing                                                              |
| Linting                     | None pre-existing                                                              |
| VS Code extension structure | None pre-existing                                                              |
| CLI                         | None pre-existing                                                              |
| APIs / AI integrations      | None pre-existing                                                              |
| Database / storage          | None pre-existing                                                              |
| Configuration               | None pre-existing                                                              |
| Documentation               | None pre-existing                                                              |
| Scripts                     | None pre-existing                                                              |

**Conclusion:** the project is genuinely greenfield. There was no existing
infrastructure to reuse, so no duplicate systems were created.

### 1.2 Environment

| Tool        | Version          |
| ----------- | ---------------- |
| Node.js     | 22.18.0          |
| npm         | 11.6.4           |
| git         | 2.50.1.windows.1 |
| Python      | 3.12.8           |
| OS          | Windows 11       |
| pnpm / yarn | not installed    |

### 1.3 Technology decisions

Because the repository is greenfield, the specification default stack (section 4)
applies.

| Concern           | Choice                                                         | Rationale                                               |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------- |
| Language          | TypeScript 5.9 (strict)                                        | Spec default; required for the VS Code extension target |
| Runtime           | Node.js >= 20.11, ESM, `NodeNext`                              | Spec default; matches installed Node 22                 |
| Package manager   | npm                                                            | Only package manager installed                          |
| Tests             | Vitest 4                                                       | Spec default; native ESM/TS, fast                       |
| Lint              | ESLint 10 flat config + `typescript-eslint` (type-aware rules) | Spec default                                            |
| Format            | Prettier 3                                                     | Spec default                                            |
| Build             | `tsc` (no bundler)                                             | Avoids an unnecessary dependency (spec section 4)       |
| Persistence       | _Deferred._ SQLite planned for the telemetry phase             | Not needed at baseline; no premature dependency         |
| Schema validation | _Deferred._ Zod planned for the configuration phase            | Not needed at baseline                                  |

**Known toolchain constraint.** TypeScript 7.0.2 is the current `latest`, but
`typescript-eslint@8.69.0` (latest) declares a peer range of
`typescript >=4.8.4 <6.1.0`. Adopting TypeScript 7 would therefore disable
type-aware linting. TypeScript is pinned to `~5.9.3` until `typescript-eslint`
supports 7.x. Recorded here so the pin is revisited deliberately rather than
silently.

### 1.4 What exists today

Re-inspected at Phase 23. The tree below is the current one; the Phase 0 version
of this section described five directories and is preserved only in git history.

```
routepilot/
├── bench/benchmark.mjs           # routing/analysis timings (spec section 69)
├── config/                       # example configuration and what to verify in it
├── docs/                         # 14 documents; every internal link is tested
├── extension/                    # the VS Code shell: a separate CommonJS package
├── scripts/
│   ├── phase-check.mjs           # `npm run phase`  — the section 72 loop
│   ├── quality-gate.mjs          # `npm run gate`   — every check, mapped to evidence
│   ├── sync-extension-core.mjs   # copies dist/ into the .vsix
│   └── verify-adapter.mjs        # a real agent, from a plain terminal only
└── src/
    ├── core/                     # provider-neutral. No vendor name, enforced by test
    │   ├── analysis/             # task classification, progressive repo analysis
    │   ├── bandit/               # UCB exploration, and the gates that suppress it
    │   ├── calibration/          # Brier, ECE, the safeguard that can switch learning off
    │   ├── escalation/           # the graph, and compact context handoffs
    │   ├── execution/            # struggle monitor, failure taxonomy, validation
    │   ├── learning/             # Beta-Bernoulli P(success | features, model)
    │   ├── outcome/              # multi-dimensional scoring of a finished task
    │   ├── perf/                 # bounded concurrency, stage timings
    │   ├── registry/             # models, providers, eligibility
    │   ├── routing/              # expected cost to success, the routing engine
    │   ├── run/                  # TaskRunner: the orchestrator
    │   ├── shadow/               # alternative policies, scored and never executed
    │   ├── types/                # the vocabulary, and every port
    │   └── ports.ts              # FileSystemPort, GitPort, DiagnosticsPort, Clock
    ├── adapters/                 # claude-code, cursor, direct, fake + the registry
    ├── cli/                      # route, run, analyze, models, status, calibration…
    ├── config/                   # Zod schema, discovery, registry construction
    ├── infra/                    # Node filesystem, git, command runner
    ├── telemetry/                # SQLite store, redaction, the run recorder
    ├── extension/                # pure VS Code presentation layer (no vscode import)
    ├── e2e/                      # whole-pipeline scenarios
    └── test-support/             # fixtures, excluded from the build
```

**Size:** 123 source files (23,305 lines) and 55 test files (16,232 lines) —
roughly seven lines of test for every ten of source. One runtime dependency
(`zod`).

### 1.5 Progressive analysis, as built

Analysis is layered by cost, and the level is earned by the task
(spec section 10):

| Level | Cost                                                     | Produces                                                                                      |
| ----- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1     | One bounded directory walk, manifest reads, one git call | File count, languages, package manager, frameworks, monorepo, CI, git state, changed files    |
| 2     | Reads a bounded set of selected files                    | Relevant files, dependencies, test presence, diagnostics, estimated context, affected modules |
| 3     | Reads source files to resolve imports                    | Approximate import graph, fan-in/fan-out                                                      |

All three levels share **one cached file inventory**. Deepening from level 1 to
level 3 performs no directory walking at all, and an unchanged repository
performs none either.

Invalidation is component-wise rather than all-or-nothing:

| What changed                     | Inventory | Level 1                    | Levels 2 and 3 |
| -------------------------------- | --------- | -------------------------- | -------------- |
| Nothing                          | kept      | kept                       | kept           |
| An existing file modified        | **kept**  | kept (git facts refreshed) | rebuilt        |
| A file added, deleted or renamed | rebuilt   | rebuilt                    | rebuilt        |
| A manifest edited                | kept      | rebuilt                    | rebuilt        |
| HEAD or branch moved             | rebuilt   | rebuilt                    | rebuilt        |

The middle row is the point: editing one line of one file in a 20,000-file
repository must not cost a full tree walk.

**Known limitation.** Level 3's import graph is built by scanning import and
require statements textually. It resolves relative imports only and will miss
dynamic and generated ones. It is flagged `approximate: true` in the type so no
consumer mistakes it for ground truth; substituting Tree-sitter or a language
server later changes the implementation, not the interface.

### 1.6 How a model is chosen

The optimisation target is **expected total cost to success**, not the price of
the first attempt (spec section 1):

```
expectedTotal(m) = initial(m)
                 + P(fail | m) x [ 0.35 x initial(m)          <- retry
                                 + 0.65 x expectedTotal(next) ]  <- escalate
```

`next` is the cheapest-to-success model strictly stronger than `m`. Candidates
are costed strongest-first, so the recursion terminates and the strongest model
has nothing to escalate to.

Selection order:

1. Hard filter — an impossible model can never be selected.
2. Explicit model request — honoured whenever viable, never silently swapped.
3. Score survivors: success, risk, latency, expected cost.
4. Keep those meeting confidence, risk, latency and budget.
5. Choose the cheapest expected path to success among them.
6. Otherwise follow the configured behaviour: try a cheaper affordable model,
   ask, stop, or exceed the budget **and say so**.

**A limitation worth stating plainly.** Expected cost alone would nearly always
open with the cheapest model: when the price gap is wide enough, "try cheap,
escalate on failure" really does minimise expected dollars even at a 35% success
rate. Money is not the only cost of a failure, though — there is latency, a
possibly half-edited workspace, and the user's patience. What prevents the
router from always gambling is `minimumSuccessProbability`, a separate
constraint. This is tested explicitly in `estimators.test.ts` rather than left
implicit.

### 1.7 Dependency rule, as built

`src/core` imports nothing from `src/config`, `src/cli`, or any future adapter,
telemetry or learning layer. Those layers depend inward on `core`. Both halves
of this — no outward imports, and no vendor name in core — are enforced by
`src/core/vendor-neutrality.test.ts` rather than left to discipline.

### 1.8 Priors are not measurements

`ModelSpec.priors` holds configured beliefs about a model's ability. It is a
separate object from anything observed, and `ModelSpec` has **no** field in
which a sample count could be recorded. Observed outcomes will live in the
telemetry store (Phase 11) and start at zero (spec section 39). Prices carry a
`verifiedAt` date so staleness is visible rather than silently assumed away.

---

## 2. The target architecture, and where it now lives

> This section was written in Phase 0 as a statement of intent. Everything in it
> is now implemented; the pointers below say where. Two things named here were
> **deliberately not built** and are called out at the end of 2.5 and in 2.7.

### 2.1 Guiding principles (spec section 2)

1. The core routing engine is **provider-neutral**. It must not contain
   provider-, IDE- or vendor-specific logic.
2. All agent/IDE integrations are **adapters** behind a stable interface.
3. Model names, pricing and capabilities are **configuration-driven**, never
   hard-coded.
4. No undocumented provider/IDE hacks; no modification of Claude Code or Cursor
   internals.
5. Budgets are never silently exceeded; explicit model selections are never
   silently overridden.
6. Learning and telemetry are **optional**. The system must remain fully usable
   with both disabled.
7. Telemetry is **local-first**. Source code, secrets and full model responses
   are not stored by default.
8. No fabricated confidence: priors are labelled as priors, and observed sample
   counts start at zero.

### 2.2 Data flow

```
                          USER
                            |
        +-------------------+-------------------+
        |   Entry points (adapters, not core)   |
        |  VS Code · CLI · Cursor · Claude Code |
        +-------------------+-------------------+
                            v
                    Task Understanding
                     (TaskClassifier)
                            v
              Progressive Repository Analysis
              (RepositoryAnalyzer L1 -> L2 -> L3)
                            v
                    Feature Extraction
                     (FeatureExtractor)
                            v
             Capability + Constraint Filtering
              (ConstraintEngine — hard filter)
                            v
        +---------------------------------------+
        |            Routing Engine             |
        |  +---------------------------------+  |
        |  | Static prior                    |  |
        |  | SuccessPredictor  P(success|.)  |  |
        |  | CostEstimator     E[cost]       |  |
        |  | RiskEstimator     risk          |  |
        |  | LearnedPolicy     (optional)    |  |
        |  +---------------------------------+  |
        |  argmin ExpectedTotalCostToSuccess    |
        |  s.t. P(success) >= min, risk <= max, |
        |       latency <= max, cost <= budget  |
        +-------------------+-------------------+
                            v
                     Selected Model
                            v
                       AgentAdapter
                            v
                        Execution
                            v
                    Execution Monitor
                     (StruggleMonitor)
                            v
                    FailureClassifier
                            v
        +---------------------------------------+
        |           EscalationEngine            |
        |  SUCCESS · RETRY · VERTICAL ·         |
        |  HORIZONTAL · PROVIDER FALLBACK ·     |
        |  HUMAN CLARIFICATION                  |
        |  (+ ContextHandoffBuilder)            |
        +-------------------+-------------------+
                            v
                     OutcomeRecorder
                            v
              TelemetryStore (local SQLite)
                            v
        LearningEngine  ->  PolicyEvaluator (offline)
                            v
                  Improved Routing Policy
                    (only after gates pass)
```

### 2.3 Module boundaries

Modules are grouped by responsibility, not one file per component.

| Layer         | Planned location      | Components                                                                                              |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------- |
| Domain types  | `src/core/types/`     | `ModelSpec`, `TaskType`, `RoutingFeatures`, `RoutingDecision`, `FailureType`, `Outcome`                 |
| Registries    | `src/core/registry/`  | `ModelRegistry`, `ProviderRegistry`, `AgentRegistry`                                                    |
| Understanding | `src/core/analysis/`  | `TaskClassifier`, `RepositoryAnalyzer`, `FeatureExtractor`                                              |
| Routing       | `src/core/routing/`   | `ConstraintEngine`, `RoutingEngine`, `CostEstimator`, `SuccessPredictor`, `RiskEstimator`               |
| Execution     | `src/core/execution/` | `StruggleMonitor`, `FailureClassifier`, `EscalationEngine`, `ContextHandoffBuilder`, `ValidationEngine` |
| Outcomes      | `src/core/outcome/`   | `OutcomeRecorder`, `TaskSuccessScore`                                                                   |
| Persistence   | `src/telemetry/`      | `TelemetryStore` (SQLite), redaction                                                                    |
| Learning      | `src/learning/`       | `LearningEngine`, `PolicyEvaluator`, calibration metrics                                                |
| Config        | `src/config/`         | `ConfigurationManager`, schema validation, defaults                                                     |
| Adapters      | `src/adapters/`       | `AgentAdapter` interface, Claude Code, Cursor CLI, direct provider                                      |
| CLI           | `src/cli/`            | `routepilot analyze / route / run / models / status / history / evaluate / config`                      |
| VS Code       | `src/extension/`      | commands, status bar, explainability UI                                                                 |

**Dependency rule.** `core` may not import from `adapters`, `cli`, `extension`,
`telemetry` or `learning`. Those depend inward on `core`. This is what keeps the
router provider-neutral, and is intended to be enforced by a lint rule once the
directories exist.

### 2.4 Key interfaces

All four are implemented. Paths are given so the description and the code cannot
drift apart unnoticed.

- **`ModelSpec`** (`src/core/types/model.ts`) — id, provider, tier, context
  window, pricing, capabilities, strength priors, language priors, availability.
  Strengths are _priors_, held separately from observed data, and a `ModelSpec`
  has nowhere to record a sample count — a test asserts it (spec sections 7
  and 39).
- **`AgentAdapter`** (`src/core/types/agent.ts`) — `id`, `capabilities`,
  `canHandle`, `execute`, `cancel`, `getStatus`, `normalizeEvent`,
  `normalizeResult`. The router never knows how an agent works internally
  (spec section 17). Implementations live in `src/adapters`; none is verified
  against its real tool.
- **`RoutingDecision`** (`src/core/types/routing.ts`) — selected model, eligible
  candidates with their per-model estimates, excluded models _with reasons_, a
  human-readable explanation, and the bandit's summary. Every decision must be
  explainable (spec section 50). It grew beyond this sketch: every term of the
  expected-cost model is exposed, along with the static probability, the
  observation count and whether learning moved the estimate.
- **`FailureType`** (`src/core/types/failure.ts`) — the closed taxonomy from
  spec section 22, fourteen kinds. Only `MODEL_WEAKNESS` may update
  model-quality beliefs, enforced at the point observations are admitted. See
  [ESCALATION.md](ESCALATION.md).

### 2.5 Cold start and learning safety

- Below `minimumTrainingSamples`, learned routing is **disabled** and static
  priors are used. The system does not claim learned probabilities it does not
  have (spec sections 35 and 39).
- New model/task combinations start at `sampleCount = 0`.
- Learned policies are evaluated **offline** against historical data and must
  pass thresholds before activation. Shadow routing records what a candidate
  policy _would_ have chosen without executing it (spec sections 42 and 43).
- Historical data has selection bias. Observed outcomes and predicted outcomes
  are recorded and reported distinctly (spec section 44).

**What was built, and one thing that was not.** Cold-start gating, calibration
safeguards, shadow routing and the selection-bias caveat are all implemented —
see [LEARNING.md](LEARNING.md) and [EVALUATION.md](EVALUATION.md).

**Offline evaluation of a learned policy against historical outcomes is not.**
Shadow routing records what an alternative policy _would_ have chosen, which is
a weaker claim than the sentence above promises: the shadow's model was never
run, so no outcome exists for it. Replaying policies against recorded outcomes
remains unbuilt, and the gap is stated wherever a shadow figure is reported.

### 2.6 Privacy and security posture

Implemented and verified against the database file itself. Full detail in
[PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

- Local telemetry only by default. No source code, secrets, `.env` contents, API
  keys or full model responses are persisted (spec section 33).
- Any local gateway binds to `127.0.0.1` by default.
- Redaction applied to keys, tokens, passwords, private keys and credentials.
- Secure process spawning with argument arrays — never shell-string
  interpolation of untrusted input (spec section 51).
- `.gitignore` already excludes `.env*`, `.routepilot/` and `*.sqlite`.

### 2.7 Explicit non-goals for the MVP

- Multi-model ensemble execution (interfaces only; it multiplies cost — spec
  section 45).
- Remote or hosted learning service.
- Automatic commits of user code (spec section 29).
- Any form of undocumented interception of Cursor or Claude Code traffic.

---

## 3. Testing strategy

Every phase must pass the same gate before the next phase begins (spec section 52):

```
npm run verify   # typecheck -> lint -> format:check -> test -> build
```

| Gate      | Command                | Purpose                                       |
| --------- | ---------------------- | --------------------------------------------- |
| Typecheck | `npm run typecheck`    | `tsc --noEmit` over src **and** tests, strict |
| Lint      | `npm run lint`         | ESLint flat config with type-aware rules      |
| Format    | `npm run format:check` | Prettier                                      |
| Test      | `npm test`             | Vitest over `src/**/*.test.ts`                |
| Build     | `npm run build`        | `tsc` emit to `dist/` (tests excluded)        |

Per-layer approach:

- **Pure core logic** (routing, cost, constraints, classification, failure
  taxonomy) — unit tests with deterministic fixtures. No network, no real
  models. This is the bulk of the suite.
- **Adapters** — tested against fakes implementing the `AgentAdapter` contract,
  with one shared contract suite run against every adapter. Real Claude Code and
  Cursor CLI integration tests are opt-in and skipped when the binary is absent.
  An adapter is not claimed to work until it has actually been exercised
  (spec section 2, rule 20).
- **Persistence** — integration tests against a temporary SQLite database.
- **Learning / policy evaluation** — replay tests over synthetic historical
  datasets with known-correct expected metrics.
- **VS Code extension** — built last, kept thin, delegating to the core.

Regression rule: any bug fixed gets a test that fails before the fix.

---

## 4. Phase plan

Phases 0-22 are recorded in [ROADMAP.md](./ROADMAP.md).

### 4.1 What is not finished

Re-derived at Phase 23 from the code, not from memory. Ordered by the priority
section 76 sets out — correctness, testability, safety, observability, simple
architecture — rather than by size.

| #   | gap                                                                                                                            | why it matters                                                                                                                                                                                                          | cost                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 1   | **No validation configuration.** `routepilot run` cannot be told how to check its own work, so every run finishes unevaluated. | Correctness _and_ safety. The one command that lets an agent edit files never checks the result, and an unevaluated run teaches the learning layer nothing — so the whole premise of expected-cost routing stays unfed. | small                             |
| 2   | **Only the request budget is enforced.** `session`, `daily` and `monthly` are validated, displayed, and ignored.               | Safety. `run --execute` is the first command that can spend real money, which makes an unenforced limit a promise the product does not keep.                                                                            | small                             |
| 3   | **No cancellation.** Ctrl-C kills the CLI; nothing calls `adapter.cancel()`, so a spawned agent can outlive it.                | Safety. An orphaned agent still holds write access to the workspace.                                                                                                                                                    | small                             |
| 4   | **No `routepilot history`.** Runs are recorded and nothing reads them back.                                                    | Observability. Telemetry nobody can see is a cost with no benefit.                                                                                                                                                      | small                             |
| 5   | **No user feedback.** `userAccepted` is always null; there is no way to say a run was good.                                    | Observability, then correctness — it is the strongest signal the outcome score can have, and nothing supplies it.                                                                                                       | medium                            |
| 6   | **No adapter verified against its real tool.**                                                                                 | Correctness. Everything below the port is unproven, and no amount of further code changes that.                                                                                                                         | needs a human at a plain terminal |
| 7   | **The extension has never run in VS Code.**                                                                                    | Same, for the editor surface.                                                                                                                                                                                           | needs a human                     |
| 8   | **Adapters report no token usage**, so cost is priced from estimates even after a run.                                         | Correctness of the recorded numbers, not of the routing.                                                                                                                                                                | medium                            |
| 9   | **No offline policy evaluation** against recorded outcomes.                                                                    | Would answer "would a different policy have done better" without spending anything.                                                                                                                                     | medium                            |

### 4.2 Sequencing, and why

**1 before everything else.** It is the only gap that unblocks another one: with
validation configured, a run produces an evaluated outcome, which produces an
observation, which is the first real data the learning layer has ever had.
Without it, items 5, 8 and 9 are all improvements to a pipeline whose central
claim remains untested.

**2 and 3 next**, because they are safety properties of a command that already
exists and can already spend money and edit files. Neither is large; both are
the kind of thing that is embarrassing to be missing rather than hard to add.

**4 before 5.** Reading back what is already recorded is smaller than adding a
new signal, and it makes the new signal inspectable once it arrives.

**6 and 7 cannot be closed by writing code.** They are listed so that no plan
pretends otherwise.

**8 and 9 last.** Both are real improvements and neither changes what RoutePilot
can be trusted to do today.

### 4.3 What is deliberately not planned

Multi-model ensembles, cloud analytics, distributed infrastructure, team
dashboards, AST indexing and repository-wide dependency graphs — the section 73
exclusion list, checked against the tree by `src/e2e/mvp-spine.test.ts`. None of
them is on this plan, and the test fails if one of them arrives quietly.
