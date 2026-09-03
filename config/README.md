# Configuration files

> **The configuration reference now lives in
> [`docs/CONFIGURATION.md`](../docs/CONFIGURATION.md).** This file covers only
> what is in this directory.

## `routepilot.example.json`

A starting point. Copy it and **verify its prices before relying on them** —
they were written from public pricing at a point in time and are checked against
no provider. A wrong price produces confidently wrong routing.

```bash
cp config/routepilot.example.json routepilot.config.json
routepilot config validate
```

The example enables telemetry (local only) and leaves learning, exploration and
shadow routing off, which are the safe defaults.

---

## Detail

`routepilot.example.json` is a starting point, not a source of truth.

Copy it to the root of your project and edit it:

```bash
cp config/routepilot.example.json routepilot.config.json
```

Then validate it:

```bash
routepilot config validate
```

## Verify the numbers before you trust them

Two kinds of value in the example are **operator inputs, not measurements**, and
RoutePilot treats them accordingly.

**Pricing and context windows** were correct for the listed provider on the date
in each model's `pricing.verifiedAt` (`2026-06-24`). Provider pricing changes.
A router that optimises for cost using stale prices optimises for the wrong
thing, so check them against the provider's current pricing page and update
`verifiedAt` when you do.

**`priors.skills` and `priors.languages`** are _priors_ — informed guesses about
relative ability, expressed in [0, 1]. They are not benchmark results, and
RoutePilot does not present them as such. They live under `priors` precisely so
that nothing can confuse them with observed outcomes, which are recorded
separately once the telemetry store exists (Phase 11) and always start at a
sample count of zero.

Tune them to your own experience. Only the _ordering_ and rough spacing matter
for cold-start routing.

## Credentials

Configuration never holds a secret. `auth.envVar` names the environment
variable that holds the credential:

```json
"auth": { "kind": "apiKey", "envVar": "ANTHROPIC_API_KEY" }
```

The schema rejects any unrecognised key, and gives a specific error when a key
looks like a credential. Configuration files are frequently committed to version
control; credentials must not be.

## Adding a provider

RoutePilot is provider-neutral — nothing in `src/core` names a vendor. Adding a
provider means adding entries here, not changing code:

```json
{
  "id": "my-local-runtime",
  "displayName": "Local runtime",
  "kind": "local",
  "endpoint": "http://127.0.0.1:11434",
  "auth": { "kind": "none" },
  "timeoutMs": 300000,
  "availability": "available"
}
```

Every model id must start with its provider's id followed by `/`, so a model can
always be traced back to its provider.

Note that `kind: "local"` earns a model no discount and no preference. Local
models compete on their configured cost and, later, on observed performance like
any other (spec section 46).

## Learning

Off by default. When `learning.enabled` is true, RoutePilot corrects each
model's configured success prior with what it has actually observed:

```json
"learning": {
  "enabled": true,
  "explorationEnabled": false,
  "minimumTrainingSamples": 200
}
```

- **`minimumTrainingSamples`** is a gate, not a hint. Below it, the configured
  prior is used untouched — the observations are still counted and still shown,
  they simply do not influence anything.
- **Priors never stop mattering.** A prior is worth 12 observations, so it keeps
  anchoring the estimate even after the gate opens. A model observed 30 times
  without a failure is not treated as certain to succeed.
- **Learning needs telemetry.** Learned statistics live in the same local
  database. With `telemetry.enabled` false there is nothing to learn from, and
  routing runs on priors — a fully supported way to operate.
- **`explorationEnabled` does nothing yet.** It is validated and displayed, and
  no code reads it.

Nothing learned ever leaves the machine. The `learned_success` table holds a
model id, a task type, a scope and three numbers; there is nowhere in it for a
prompt, a path or source text to appear.

Run `routepilot route "<task>"` to see what has been learned: a `LEARNED FROM`
column appears once anything has been observed, showing the run count behind
each estimate and `no data` for models that have none.

## Calibration

A learned success probability is only useful if it is _true_. RoutePilot scores
its own predictions against what actually happened, and withdraws learning when
the numbers stop meaning what they say:

```json
"learning": {
  "enabled": true,
  "minimumTrainingSamples": 200,
  "calibration": {
    "minimumSamples": 50,
    "maxExpectedCalibrationError": 0.15,
    "maxCalibrationError": 0.3,
    "minimumBrierSkillScore": 0.02,
    "requireCalibration": false
  }
}
```

There are three verdicts, and the middle one matters:

- **trusted** — measured and within every limit. Learning applies.
- **not yet assessed** — fewer than `minimumSamples` predictions. This is _not_
  a failure, and by default learning still runs under `minimumTrainingSamples`.
  Set `requireCalibration` to block it instead.
- **distrusted** — measured and outside a limit. Learning is withdrawn and the
  configured priors come back. This overrides `minimumTrainingSamples`: volume
  of evidence is not quality of prediction.

`minimumBrierSkillScore` deserves a note. A predictor that answers the same
probability to every task and is right that often is _perfectly calibrated_ and
completely useless — its skill score is exactly 0. The default floor of 0.02
requires the predictor to explain at least a little of the variation in
outcomes, which is what stops it replacing the models' differentiated priors
with one flat number. Lower it below 0 only if you know why.

Run `routepilot calibration` to see the reliability table:

```
BAND     N    PREDICTED  ACTUAL  GAP
0.9-1.0  100  90%        60%     +30.0pp
```

A positive gap is over-confidence — the router spends on attempts that fail. A
negative gap is under-confidence — it escalates to models it did not need.

## Shadow policies

RoutePilot can evaluate alternative routing policies alongside the live one and
record what they _would_ have chosen:

```json
"shadow": {
  "enabled": true,
  "policies": ["priors-only", "cheapest-first", "strongest-first"]
}
```

**No shadow policy ever executes a model.** Each one produces a model id, which
is recorded and compared; nothing is sent to a provider. Enabling this costs
nothing to run and writes one row per policy per request.

The three baselines answer different questions:

| policy            | question it answers                                   |
| ----------------- | ----------------------------------------------------- |
| `priors-only`     | Is learning changing any decisions at all?            |
| `cheapest-first`  | Would just picking the cheapest model do as well?     |
| `strongest-first` | How much more would always using the best model cost? |

An unknown policy id is a configuration error, not a silently ignored entry — a
typo that quietly dropped a comparison would leave you believing you were
measuring something you were not.

Read the results with `routepilot shadow`:

```
POLICY           N  AGREED  DIVERGED  EST. COST DELTA
strongest-first  5  20%     4         +2.5829 over 4
```

**The cost figure is an estimate, not a measurement.** The shadow's model was
never run, so there is no outcome for it, and both sides of the comparison come
from the same success probabilities — if those are miscalibrated, the difference
inherits the error rather than revealing it. A negative figure is not money you
missed out on saving. Establishing that a policy is genuinely better needs
outcomes for both arms.

## Safe exploration

RoutePilot can occasionally try a model it does _not_ currently believe is best,
to find out whether it is better than its configured prior suggests. This is off
by default:

```json
"learning": {
  "enabled": true,
  "exploration": {
    "enabled": false,
    "minimumObservations": 200,
    "maxRisk": 0.3,
    "maxCostPremium": 0.25,
    "optimism": 1.5
  }
}
```

**Exploration never happens on:**

- a task above `maxRisk`
- a task carrying a hazard — destructive, production, security, credentials,
  payments, or a data migration — **whatever its risk score says**
- a request where you named a model with `--model`
- anything run with `--mode production` or `--mode critical`
- a request with no budget headroom, or `maxCostPremium` of 0

It also stays off until `minimumObservations` outcomes exist, and is withdrawn
whenever the calibration safeguard has withdrawn learning.

**`--mode` defaults to `production`.** Forgetting the flag suppresses
exploration rather than permitting it, and a typo (`--mode prodution`) is a hard
error rather than a silent fallback — the one direction a mistake must not fail
in is _towards_ experimenting.

`maxCostPremium` is the price of information: at 0.25 the router will pay a
quarter more than the safe choice to learn something, and not a penny more.
`optimism` is how many standard deviations of benefit of the doubt an uncertain
model gets; higher explores more readily. Neither can authorise an experiment
the safety list above forbids.

Exploration is **deterministic** — no sampling — so two identical requests give
identical answers, and it is self-limiting: as observations accumulate the
uncertainty shrinks and experiments stop on their own. In simulation over 300
tasks it explored 5 times, then committed.
