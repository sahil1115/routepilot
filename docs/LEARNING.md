# Learning

RoutePilot learns exactly one thing: **P(success | features, model)**.

Not a policy, not a value function, not a reward model — a calibrated
probability that replaces a guessed prior with an observed rate, and feeds the
same expected-cost arithmetic that was already deciding routes.

**It is off by default**, and stays off until it has earned the right to be on.

---

## Why only that one number

The routing objective is expected cost to success:

```
expectedTotal(m) = initial(m) + P(fail | m) x recovery(m)
```

Every term except `P` is arithmetic over configured prices. `P` is the only
thing RoutePilot is guessing, so it is the only thing worth learning. A better
`P` improves routing through machinery that already exists.

---

## The model: Beta-Bernoulli with backoff

A prior is treated as if it were `strength` imaginary observations at rate
`prior` (default **12**). Real observations are added:

```
mean = (strength x prior + successMass) / (strength + observations)
```

Three properties follow, and each is asserted in the tests:

- **Zero observations returns the prior exactly.** Not 0.5, not zero.
- **Sparse observations barely move it.** One success against a prior of 0.6
  gives 0.63, not 1.0. A single lucky run cannot promote a model.
- **Enough observations dominate.** The prior's fixed weight is swamped, which
  is what lets learning correct a prior that was simply wrong.

### Backoff, because data is always sparse somewhere

Observations are stored per `(model, task type, scope)` and read back as a
three-level chain:

```
configured prior
  -> this model on OTHER task types      (general competence)
  -> this task type, OTHER scopes        (competence at this kind of work)
  -> this exact bucket                   (competence at exactly this)
```

**The levels partition the data; they do not nest.** Each counts only what the
deeper levels exclude, so every observation enters the chain exactly once and
the three counts sum to the model's total.

The obvious alternative — each level aggregating everything beneath it — would
feed the same evidence through the shrinkage three times and produce confidence
that grew with the depth of the hierarchy rather than with the evidence. That
was an actual bug during development, caught by an invariant test.

---

## Sample counts are real counts

The prior's twelve pseudo-observations exist **only inside the arithmetic**.
They are never reported as data.

`shrinkToPrior` rejects a non-integer observation count outright, because a
fractional sample count is the exact shape a fabricated one would take:
weighting observations by confidence and calling the total a number of
observations. Partial success lives in a separate `successMass` instead.

When observations exist but are not being used, the CLI says so:

```
MODEL                SUCCESS  LEARNED FROM
anthropic/haiku-4-5  56%      80 runs (prior: 56%)
```

A count beside an unchanged probability would otherwise read as though the
number had been learned.

---

## What may be learned from

An outcome is admitted only if **all** of these hold:

- it is **model-attributable** — not a provider outage, environment failure or
  cancellation
- something was actually evaluated (`score !== null`; unknown is not failure)
- the score rests on at least 25% of the possible evidence
- **exactly one model was involved** — after an escalation there is no honest
  way to say whose work produced the result

That last rule is a real limitation, not an oversight. Splitting the credit
would be inventing data; assigning it to one model would be worse.

---

## Two gates before it influences anything

### 1. Enough data

`minimumTrainingSamples` (default **200** per model). Below it the configured
prior is returned untouched — and the observation count is still reported
honestly, because hiding it would misrepresent how much RoutePilot knows.

### 2. Calibrated enough to believe

Learned probabilities are scored against what actually happened, and withdrawn
if they are measurably wrong. See [EVALUATION.md](EVALUATION.md) for the
metrics. Three verdicts:

| verdict      | meaning                      | learning                        |
| ------------ | ---------------------------- | ------------------------------- |
| `trusted`    | measured, within every limit | applies                         |
| `unassessed` | too few predictions to judge | applies (unless proof required) |
| `distrusted` | measured, outside a limit    | **withdrawn; priors restored**  |

`distrusted` **overrides the training minimum**: volume of evidence is not
quality of prediction.

`unassessed` is deliberately not a failure. Requiring proof before activation
would deadlock — predictions only accumulate while learning is active — so the
default is "withdraw on evidence of miscalibration", and `requireCalibration`
gives the strict behaviour to operators who want it.

---

## Safe exploration (the contextual bandit)

Exploration means deliberately choosing a model RoutePilot does **not** believe
is best, to find out whether it might be. Off by default.

### It is deterministic

Not Thompson sampling. Determinism has been a hard requirement since Phase 3,
and architectural principle 9 forbids randomly selecting an expensive model. An
upper confidence bound gives the same optimism deterministically:

```
UCB = mean + optimism x sqrt( p(1-p) / (concentration + 1) )
```

Every candidate is scored optimistically, **including the exploiting one**. An
earlier version compared each alternative's optimistic cost against the exploit
choice's _expected_ cost, which starves whichever arm is currently preferred —
one arm sat at five observations for three hundred simulated rounds while the
other was "explored" every single time.

### The objective is still cost, not success

Maximising success probability would explore the most expensive model on every
task. Instead the optimistic probability is substituted into the same
expected-cost model, so a candidate is worth trying only if it could plausibly
be **cheaper overall**. Expensive models are therefore rare exploration targets.

### Exploration never happens when

- the task is above `maxRisk`
- the task carries a hazard — `destructive`, `production`, `security`,
  `credentials`, `payments`, `data-migration` — **whatever its risk score says**
- a model was named explicitly with `--model`
- the mode is `production` or `critical`
- there is no budget headroom, or `maxCostPremium` is 0
- there are fewer than `minimumObservations` outcomes
- the calibration safeguard has withdrawn learning

`--mode` **defaults to `production`**. Forgetting the flag suppresses
experiments; it never authorises them. A typo is a hard error.

### It pays for itself, and stops

In simulation over 300 tasks with known true success rates:

| policy           | total cost | successes   | final choice       | experiments |
| ---------------- | ---------- | ----------- | ------------------ | ----------- |
| exploit only     | 44.57      | 270/300     | the **worse** arm  | 0           |
| with exploration | **27.91**  | **293/300** | the **better** arm | **5**       |

37% cheaper, and exploration stopped after round 9 — five experiments out of
three hundred, then commitment. Stable across optimism 1.0 to 2.5.

---

## Where the data lives

Local SQLite, never uploaded. The `learned_success` table holds a model id, a
task type, a scope and three numbers — there is nowhere in it for a prompt, a
path or source text to appear. See [PRIVACY.md](PRIVACY.md).

---

## Limitations

1. **Nothing writes observations in production.** The task runner records them
   when a learning model is supplied, but no CLI command drives it — so in a
   real installation the training minimum is never reached and learning never
   activates. The simulation is currently the only place it runs.
2. **No time decay.** A model whose real performance changes is learned slowly,
   and old observations never expire. Weighting recent outcomes would need a
   clock in the estimate path and would break determinism.
3. **Escalated tasks teach nothing** (see above).
4. **Not contextual in the full sense.** The bandit consumes per-(model, task,
   scope) estimates; it does not fit a model across features, so it will not
   generalise to an unseen context.
5. **Language and framework are not learned over**, though spec section 38 asks
   for them. Only model, task type and scope.
6. **`minimumTrainingSamples` defaults to 200 per model**, which is a great many
   real runs before anything happens. Deliberate, but it means learning is inert
   for a long time.
