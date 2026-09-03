# Configuration

RoutePilot is configured by a single JSON file. Everything vendor-specific lives
in it — model names, prices, capabilities, endpoints — because the core is
provider-neutral and must not name a vendor anywhere (an architectural test
enforces this).

A starting point ships at [`config/routepilot.example.json`](../config/routepilot.example.json).
**Copy it and check its prices before relying on them.**

```bash
cp config/routepilot.example.json routepilot.config.json
routepilot config validate
```

---

## Where the file is found

In order:

1. `--config <path>`
2. `$ROUTEPILOT_CONFIG`
3. `routepilot.config.json`, then `.routepilot.json`, in the working directory
4. The bundled example — used only by commands that opt in, and always announced
   on stderr

Validation is strict: an unknown key is an error, not a warning. A typo that
silently did nothing would leave you believing a setting was in force when it
was not.

---

## Shape

```jsonc
{
  "version": 1,
  "providers": [/* who serves models */],
  "models": [/* what can be routed to */],
  "routing": {/* thresholds and limits */},
  "budgets": {/* spending limits */},
  "learning": {/* off by default */},
  "shadow": {/* off by default */},
  "telemetry": {/* local only */},
}
```

---

## Models

A model entry is a **capability profile**: what it costs, how large its context
is, what it can do, and how good it is believed to be at each kind of work.

```jsonc
{
  "id": "anthropic/sonnet-5", // must start with its provider's id
  "providerId": "anthropic",
  "modelId": "sonnet-5", // what the provider calls it
  "displayName": "Claude Sonnet 5",
  "tier": "medium", // cheap | medium | frontier | ultra
  "contextWindow": 500000,
  "maxOutputTokens": 64000,
  "pricing": {
    "inputPerMillion": 3,
    "outputPerMillion": 15,
    "cachedInputPerMillion": 0.3, // optional; no discount is assumed without it
    "currency": "USD",
  },
  "capabilities": {
    "toolUse": true,
    "agenticExecution": true,
    "streaming": true,
    "structuredOutput": true,
    "vision": false,
  },
  "latency": { "firstTokenSeconds": 1.0, "outputTokensPerSecond": 95 },
  "availability": "available", // available | degraded | unavailable
  "priors": {
    "skills": { "codeGeneration": 0.87, "debugging": 0.82 },
    "languages": { "typescript": 0.87 },
  },
}
```

### Priors are judgements, not measurements

`priors` are your beliefs about a model, expressed as probabilities in `[0, 1]`.
Nine skill dimensions are recognised: `codeGeneration`, `codeEditing`,
`debugging`, `refactoring`, `architecture`, `reasoning`, `testGeneration`,
`documentation`, `multiFileReasoning`.

A **missing** skill is not zero — it means "unknown", and RoutePilot falls back
to the tier's baseline. There is nowhere in a model entry to record a sample
count, deliberately: a configured belief must not be able to dress itself up as
evidence.

Once learning is enabled, observations correct these. The prior never stops
mattering — it is worth twelve observations, so a model observed thirty times
without a failure is still not treated as certain.

### Tiers

`tier` is a coarse capability band used for escalation ordering and as a
tie-break. **It is not a routing rule.** A cheap model that reliably succeeds
wins over a frontier model regardless of tier, because the objective is expected
cost to success.

---

## Routing

```jsonc
"routing": {
  "minimumSuccessProbability": 0.85,  // below this, a model is not selectable
  "maxRisk": 0.5,
  "maxLatencySeconds": 900,
  "maxEscalationsPerTask": 2,
  "maxRetriesPerModel": 1,
  "maxExecutionTimeMs": 900000,       // optional: wall-clock cap across every attempt
  "modelOverrideEnabled": false       // may the router override an explicit --model?
}
```

`modelOverrideEnabled` defaults to **false**. An explicit choice is a decision,
not a hint.

`maxEscalationsPerTask`, `maxRetriesPerModel` and `maxExecutionTimeMs` are the
limits `routepilot run --execute` applies during execution. Until Phase 24 the
first two were validated and then ignored in favour of built-in defaults.

---

## Budgets

```jsonc
"budgets": {
  "currency": "USD",
  "request": 1.0,
  "session": 10.0,
  "daily": 25.0,
  "monthly": 300.0,
  "onExceeded": "ask"                 // ask | stop | allow-fallback
}
```

An absent limit means "not limited at this scope", never zero.

> **Only `request` is enforced.** `session`, `daily` and `monthly` are validated
> and displayed and **nothing applies them**. This is a real gap, not a
> simplification — see [Limitations](#limitations).

`request` bounds two things. At routing time, no model whose expected total
cost to success exceeds it is selected. At execution time it becomes the cap on
total spend across every attempt, retry and escalation of the run, and the next
attempt is not started if it is projected to take the total past it.

RoutePilot never silently exceeds a budget. The one way past it is an explicit
`--model` whose estimate is over the request budget, and `onExceeded` decides
what happens then:

| `onExceeded`     | `routepilot run --execute --model X`                                  |
| ---------------- | --------------------------------------------------------------------- |
| `stop`           | refuses, exit code 3, naming the model, the estimate and the budget   |
| `ask`            | refuses the same way, and names `--allow-over-budget` as the override |
| `allow-fallback` | executes, and prints the overspend in the run's outcome               |

There is no interactive prompt: the CLI is scripted, so `ask` means "refuse
until told otherwise on the command line". A plan (without `--execute`) shows
the over-budget marker and refuses nothing.

---

## Learning

Off by default. See [LEARNING.md](LEARNING.md).

```jsonc
"learning": {
  "enabled": false,
  "minimumTrainingSamples": 200,
  "calibration": {
    "minimumSamples": 50,
    "maxExpectedCalibrationError": 0.15,
    "maxCalibrationError": 0.3,
    "minimumBrierSkillScore": 0.02,
    "requireCalibration": false
  },
  "exploration": {
    "enabled": false,
    "minimumObservations": 200,
    "maxRisk": 0.3,
    "maxCostPremium": 0.25,
    "optimism": 1.5
  }
}
```

Learning needs telemetry: with `telemetry.enabled` false there is nothing to
learn from, and routing runs on priors — a fully supported way to operate.

---

## Shadow policies

Off by default. See [EVALUATION.md](EVALUATION.md).

```jsonc
"shadow": {
  "enabled": false,
  "policies": ["priors-only", "cheapest-first", "strongest-first"]
}
```

Costs nothing to run — no shadow policy ever executes a model — and writes one
row per policy per request. An unknown policy id is a validation error.

---

## Telemetry

> **Storing telemetry needs Node 22.5 or newer.** RoutePilot itself requires
> only Node 20.11: routing, analysis, escalation and the CLI all work there.
> The local store is built on `node:sqlite`, which arrived in Node 22.5, so on
> an older runtime telemetry degrades to a store that records nothing and says
> so by name. Nothing crashes and no task fails — the system is required to work
> with telemetry disabled (spec section 2, rule 17), and this is that path taken
> automatically.
>
> The same applies to the VS Code extension: hosts before VS Code 1.96 ship
> Node 20, so history is unavailable there for the same reason and with the same
> message.

```jsonc
"telemetry": {
  "enabled": true,
  "privacyMode": "strict",            // strict | debug
  "storagePath": "~/.routepilot"      // optional
}
```

Local SQLite, never uploaded. See [PRIVACY.md](PRIVACY.md).

---

## Credentials

Never in the configuration file. A provider names an environment variable:

```jsonc
{ "id": "anthropic", "auth": { "kind": "apiKey", "envVar": "ANTHROPIC_API_KEY" } }
```

`routepilot status` reports whether the variable is set. It never prints the
value.

---

## Editor settings

The VS Code extension reads a few settings, and they may only make RoutePilot
**more** careful — a workspace `settings.json` arrives with a repository and is
not trusted to widen a limit. See [EXTENSION.md](EXTENSION.md).

---

## Limitations

1. **Prices are yours to verify.** The example file's numbers were written from
   public pricing at a point in time and are not checked against any provider.
   A wrong price produces confidently wrong routing.
2. **`session`, `daily` and `monthly` budgets are not enforced.**
3. **`priors` are guesses until learning has data**, and learning is off by
   default. Out of the box, every routing decision rests on numbers a human
   typed.
4. **Latency figures are configured, not measured.** They feed the latency cap
   and the overhead ratio in [PERFORMANCE.md](PERFORMANCE.md).
