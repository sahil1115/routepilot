# RoutePilot

**Choose the cheapest path to success.**

RoutePilot is an intelligent model router for coding agents. Given a task and a
repository, it decides which model should do the work, explains why, and says
what it expects to cost.

> ### Status: honest about what it is
>
> RoutePilot **routes, runs, and edits code**. Every adapter has been driven
> against its real tool, and the whole loop has been driven end to end.
>
> **What works, and how that was shown**
>
> - **Both coding agents are verified against their real tools.** Claude Code
>   2.1.72 and Cursor CLI 2026.09.02 each scored **4/4** on the same fixture
>   suite on 2026-09-04 — fixing a failing test suite, creating a file,
>   declining to fabricate a missing one, and cancelling mid-run. Every
>   assertion observed the filesystem or the process, never the transcript.
> - **The direct HTTP adapter is verified too**, on 2026-09-06 against the
>   Anthropic Messages API: 4/4, including a real streamed request reporting
>   token usage. See [docs/DIRECT_PROVIDER.md](docs/DIRECT_PROVIDER.md).
> - **The whole loop works end to end** (2026-09-08). A real agent fixed a
>   fixture, RoutePilot ran the workspace's own tests, and the run reported
>   `succeeded` with the outcome recorded and learned from — routing, execution,
>   validation, telemetry and learning in one pass. See
>   [docs/RUN_LOOP.md](docs/RUN_LOOP.md).
> - **Spend is measured, not only estimated.** Where an adapter reports token
>   usage, each attempt records what was projected and what it actually cost,
>   and the difference corrects the projection routing acts on — priced at the
>   upper end of a confidence interval, so being wrong costs a dearer model
>   rather than an overspend. Observed correcting a live decision on 2026-09-09.
> - **It will not claim a success it did not check.** A run reports `unverified`
>   rather than `succeeded` when your workspace declares no test, build or
>   typecheck script. RoutePilot never takes the agent's word for it.
> - **The VS Code extension runs in real VS Code** (1.136.0, Node 24.18.1):
>   8/8 extension-host checks, plus 19 against a fake host.
> - **1456 tests across 70 files**, and `npm run gate` maps every quality-gate
>   item to the evidence for it.
>
> **Still in progress**
>
> - **Escalation between models has not yet run for real.** The machinery is
>   built and covered by tests; no real task has produced one. This is the
>   largest remaining gap.
> - **Claude Code needs a permission mode to write.** With none set it scores
>   2/4, because print mode cannot prompt and every edit is declined. Set
>   `agents."claude-code".permissionMode` to `acceptEdits`. RoutePilot passes no
>   mode by default and will not widen your permissions for you.
> - **One provider protocol ships.** The direct adapter is proven against
>   Anthropic; every other provider needs its own.
> - **Cost correction is proven on six runs, not in production use**, and it
>   currently measures token-estimate error rather than a stale price — both
>   sides of the ratio use the same configured price table, so the price
>   cancels out.
>
> Every one of those is stated wherever it matters, not only here. See
> [Limitations](#limitations).

---

## The idea

Most routers optimise the price of the next request. That is the wrong target.

A model costing $0.02 that fails 40% of the time is more expensive than one
costing $0.07 that fails 10%, once you pay for the retry and the escalation. So
RoutePilot minimises **expected total cost to a successful completion**:

```
expectedTotal(m) = initial(m) + P(fail | m) x recovery(m)

recovery(m)      = retryShare      x retry(m)
                 + escalationShare x escalation(m)

escalation(m)    = expectedTotal(next) x (1 + handoffOverhead)
```

Every term is exposed on the decision, so a route can be checked rather than
taken on trust.

**This does not always favour the cheap model.** With the default recovery
shares, a cheaper model is the dearer path only when its first attempt costs
roughly 85–90% of the alternative's. When a model is _much_ cheaper, trying it
first genuinely is the cheaper expected path even at a mediocre success rate —
which is exactly why `minimumSuccessProbability` exists as a separate
constraint. Expected dollars alone would always gamble, and dollars are not the
only cost of a failure.

---

## How routing works

```
prompt + repository
        |
        v
  classify task          type, scope, risk, hazards, ambiguity
        |
        v
  analyse repository     progressive levels 1-3, cached
        |
        v
  extract features       one vector, no vendor anywhere
        |
        v
  hard filter            context window, capabilities, availability
        |
        v
  score every candidate  P(success), risk, latency, expected cost
        |
        v
  apply policy           threshold, risk cap, latency cap, budget
        |
        v
  cheapest expected path to success
```

Selection is **deterministic**. No clock, no randomness, no iteration over
unordered structures — the same inputs always produce byte-identical decisions,
including the order of every list in the result.

The tier of a model is a tie-break and an escalation ordering. **It is not a
routing rule.** On the specification's own examples the ladder falls out of the
arithmetic:

| task                                             | routes to |
| ------------------------------------------------ | --------- |
| "Rename this variable."                          | cheap     |
| "Add a standard REST endpoint."                  | medium    |
| "Refactor authentication across the repository." | frontier  |

---

## Try it

```bash
npm install
npm run build

# Is RoutePilot ready to work here, and what can it do?
node dist/cli/main.js status

# Choose a model for a task, and see the reasoning
node dist/cli/main.js route "add pagination to the users endpoint" --explain

# Route a task and run it. Plans by default; --execute actually starts an agent
node dist/cli/main.js run "add pagination to the users endpoint"
node dist/cli/main.js run "add pagination to the users endpoint" --execute

# Understand a task and the repository it targets, without routing
node dist/cli/main.js analyze "refactor the auth module"

# Which models can handle a 300k-token agentic task?
node dist/cli/main.js models --context 300000 --require agenticExecution

# Are RoutePilot's own success predictions any good?
node dist/cli/main.js calibration

# Would a different policy have chosen differently?
node dist/cli/main.js shadow
```

Without a configuration file the CLI falls back to the bundled example and says
so on stderr. **Check its prices before relying on them.**

Requires Node ≥ 20.11.

---

## Documentation

| document                                  | what it covers                                            |
| ----------------------------------------- | --------------------------------------------------------- |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md)   | how the pieces fit, and the dependency rule               |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | the config file, models, priors, budgets                  |
| [ESCALATION.md](docs/ESCALATION.md)       | failure taxonomy, escalation graph, handoffs              |
| [LEARNING.md](docs/LEARNING.md)           | learning P(success), calibration gating, safe exploration |
| [EVALUATION.md](docs/EVALUATION.md)       | calibration metrics, shadow routing, scenarios            |
| [INTEGRATIONS.md](docs/INTEGRATIONS.md)   | the adapter model and verification status                 |
| [CLAUDE_CODE.md](docs/CLAUDE_CODE.md)     | the Claude Code adapter                                   |
| [CURSOR.md](docs/CURSOR.md)               | the Cursor adapter                                        |
| [EXTENSION.md](docs/EXTENSION.md)         | the VS Code extension, and what is unverified             |
| [PERFORMANCE.md](docs/PERFORMANCE.md)     | measured timings and what was optimised                   |
| [PRIVACY.md](docs/PRIVACY.md)             | what is stored, what never is                             |
| [SECURITY.md](docs/SECURITY.md)           | process spawning, credentials, spending limits            |
| [DEVELOPMENT.md](docs/DEVELOPMENT.md)     | the phase loop, and the rules work is done under          |
| [ROADMAP.md](docs/ROADMAP.md)             | phase-by-phase status                                     |

---

## What is built

| capability                                                                                  | state                               |
| ------------------------------------------------------------------------------------------- | ----------------------------------- |
| Task classification and progressive repository analysis                                     | working                             |
| Expected-cost routing with hard constraints and budgets                                     | working                             |
| CLI: `route`, `analyze`, `models`, `providers`, `config`, `status`, `calibration`, `shadow` | working                             |
| Failure taxonomy, execution monitor, validation engine                                      | working                             |
| Escalation graph with compact handoffs                                                      | working                             |
| Outcome model and local SQLite telemetry                                                    | working                             |
| Learning P(success), with calibration safeguards                                            | working, **off by default**         |
| Shadow policies and a contextual bandit                                                     | working, **off by default**         |
| Task runner joining the whole pipeline                                                      | working, driven by `routepilot run` |
| VS Code extension                                                                           | **verified in real VS Code 1.136**  |
| Agent adapters: Claude Code, Cursor                                                         | **verified against the real tool**  |
| Agent adapters: direct HTTP                                                                 | implemented, **unverified**         |

---

## Limitations

The ones that would matter most if you were considering using this:

1. **Escalation between models has never happened for real.** This is now the
   largest remaining gap. It is a `TaskRunner` decision across two attempts, and
   no real run has produced one — the fixture ships a failing test, so it cannot
   trigger the one classification that escalates. Cursor also reports no token
   usage, so its costs are estimates rather than measurements.
2. **The loop is verified on Windows, through Claude Code, once.** Six checks
   passed end to end on 2026-09-08 — see
   [docs/RUN_LOOP.md](docs/RUN_LOOP.md). Budget enforcement across real
   attempts, retry and provider fallback against a real agent, and any other
   platform remain unconfirmed.
3. **The direct provider is verified for one provider and one shape.** Anthropic
   only, and a few tokens of plain text — no tool use, no structured output, no
   long or interrupted streams. Every other provider needs its own
   `ProviderProtocol`, and none ships.
4. **`session`, `daily` and `monthly` budgets are not enforced.** Only `request`
   is applied.
5. **Learning is inert in practice.** It needs 200 recorded outcomes per model,
   and nothing records outcomes without a run command.
6. **Prices and priors in the example config are typed by a human**, unverified
   against any provider, and wrong ones produce confidently wrong routing.
7. **Costs are measured only where an adapter reports usage.** Claude Code and
   the direct provider do; Cursor reports none, so its figures stay estimates.
   Every latency figure is still an estimate.
8. **Cost correction is proven on six real runs, not in production use.** On
   2026-09-09 six `run --execute` passes against Claude Code accumulated
   measured usage; the sixth was corrected to 0.79x and its projection moved.
   Real usage ran at 0.68x the configured price, and the bound sat above that
   mean — conservative, as designed. Six runs on one model is evidence that the
   mechanism works, not that any particular price table is right.

---

## Development

```bash
npm run phase               # the section 72 phase loop: run, check, verdict
npm run gate                # the full quality gate: every check, mapped to evidence
npm run verify              # typecheck -> lint -> format -> test -> build
npm run bench               # performance benchmarks
npm run verify:extension    # the VS Code shell, against a fake host
npm run verify:adapters -- claude-code   # a real tool; plain terminal only
```

### Rules this project holds itself to

- **The core names no vendor.** An architectural test fails the build if any
  file under `src/core` mentions a model, provider or product.
- **Nothing is "supported" until it has been run for real.** Claiming otherwise
  is worse than lacking the feature.
- **Absent is not zero.** A check that did not run is `null`, never `false`. A
  model with no observations has an unknown success rate, not a bad one.
- **Sample counts are real counts.** Prior pseudo-counts never appear as data.
- **Determinism is not negotiable.** No sampling, no clock in a decision.
- **Every limitation gets written down.** A limitation that is recorded is a
  known constraint; one that is not is a future bug.

---

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 Sahil.
