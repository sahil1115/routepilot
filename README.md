# RoutePilot

**Choose the cheapest path to success.**

RoutePilot is an intelligent model router for coding agents. Given a task and a
repository, it decides which model should do the work, explains why, and says
what it expects to cost.

> ### Status: honest about what it is
>
> RoutePilot **routes**. It does not yet **run**.
>
> - The routing pipeline is complete and tested — 1215 tests across 49 files,
>   and `npm run gate` maps every quality-gate item to the evidence for it.
> - **The Claude Code adapter is verified**: a real task ran against Claude
>   Haiku 4.5 through Claude Code 2.1.72 on 2026-09-03 and completed. The Cursor
>   and direct HTTP adapters remain **unverified**.
> - **`routepilot run` still plans by default.** `--execute` starts a real
>   coding agent; only the trivial, tool-free path has been proven.
> - **The VS Code extension is verified in real VS Code** (1.136.0, Node
>   24.18.1): 8/8 extension-host checks plus 19 against a fake host. It is the
>   one integration that has been proven end to end.
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
| Agent adapters: Claude Code                                                                 | **verified against the real tool**  |
| Agent adapters: Cursor, direct HTTP                                                         | implemented, **unverified**         |

---

## Limitations

The ones that would matter most if you were considering using this:

1. **One adapter has been executed against a real model, once.** Claude Code
   2.1.72 ran a trivial task against Claude Haiku 4.5 on 2026-09-03 and returned
   `completed`. That proves the transport, the event schema and usage
   reporting. It does not prove cancellation, timeout handling, failure
   classification, or any task that needs tool use — and `cursor-cli` and
   `direct-provider` remain unverified. The table is in `routepilot status`.
2. **`routepilot run --execute` has never been run against a real agent.** The
   command exists and the spine is wired; every end-to-end assertion behind it
   still uses a scripted executor.
3. **Only the extension is verified end to end.** It runs in a real VS Code
   host; no agent adapter has been run against its real tool, which is the gap
   that matters more.
4. **`session`, `daily` and `monthly` budgets are not enforced.** Only `request`
   is applied.
5. **Learning is inert in practice.** It needs 200 recorded outcomes per model,
   and nothing records outcomes without a run command.
6. **Prices and priors in the example config are typed by a human**, unverified
   against any provider, and wrong ones produce confidently wrong routing.
7. **Every cost and latency figure is an estimate**, never a measurement.

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
