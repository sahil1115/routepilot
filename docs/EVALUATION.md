# Evaluation

How RoutePilot checks whether it is any good — and, more importantly, what those
checks cannot establish.

Three mechanisms, answering three different questions:

| mechanism          | question                                             |
| ------------------ | ---------------------------------------------------- |
| **Calibration**    | can this probability be believed?                    |
| **Shadow routing** | would a different policy have chosen differently?    |
| **Scenarios**      | does the whole pipeline behave correctly end to end? |

---

## Calibration

A learned success probability is only useful if it is _true_. Calibration scores
predictions against what actually happened.

### Two different failures

- **Miscalibration.** The model says 90% and is right 60% of the time. The
  ranking may be fine; the number cannot be believed as a probability — which
  matters enormously here, because the expected-cost arithmetic multiplies by it.
- **No discrimination.** The model says 78% for everything and is right 78% of
  the time. Perfectly calibrated, and useless.

One number cannot express both, so the report carries several.

### The metrics

```
Brier score  = mean( (p - o)^2 )                     lower is better
             = reliability - resolution + uncertainty

reliability  = sum_k (n_k/N) (pbar_k - obar_k)^2     lower is better
resolution   = sum_k (n_k/N) (obar_k - obar)^2       higher is better
uncertainty  = obar (1 - obar)                       a property of the data

ECE          = sum_k (n_k/N) |pbar_k - obar_k|       lower is better
MCE          = max_k |pbar_k - obar_k|               lower is better
skill        = 1 - BS / BS_baseRate = (res - rel) / unc
```

The Murphy decomposition is **checked, not assumed**: `decompositionResidual`
reports the leftover, which is ~1e-16 on every fixture.

An empty bin contributes nothing — counting it as a zero gap would dilute ECE by
the number of empty bins and flatter every report. A `null` skill score means
every outcome was identical, so there was nothing to improve on; returning a
number would manufacture a claim out of a division by zero.

### The safeguard

Four ways to fail, because one metric cannot catch them all:

1. **ECE too high** — the probabilities are wrong on average
2. **MCE too high** — they are wrong somewhere specific, which an average hides,
   and routing acts hardest in exactly the high-confidence range
3. **Skill too low** — the predictor explains too little of the outcome variance
4. **Systematic over-confidence** — a signed bias ECE cannot express, and the
   direction that costs money

The skill floor is deliberately **above zero** (0.02). A predictor answering the
base rate to everything scores _exactly_ 0 with perfect calibration — and
applying it would replace the models' differentiated priors with one flat
number, destroying real signal. That hole was found by running the metrics
against a `noSkill` fixture and seeing it come back `trusted`.

### Reading the report

```bash
routepilot calibration
```

```
Learned estimates — DISTRUSTED (withdrawn, priors restored)
  predictions are poorly calibrated (little or no advantage over
  assuming the base rate (skill -0.375 below 0.020))

  Brier score:         0.3300 (lower is better, 0 is perfect)
  skill vs base rate: -0.3750 (higher is better)
  bias:               +0.3000 (over-confident: spends on attempts that fail)

  BAND     N    PREDICTED  ACTUAL  GAP
  0.9-1.0  100  90%        60%     +30.0pp
```

Learned estimates and configured priors are scored **separately and always
both** — pooling them would let good priors disguise bad learning.

---

## Shadow routing

Evaluates alternative policies alongside the live one, recording what they
_would_ have chosen. **No shadow policy ever executes a model.**

```bash
routepilot shadow
```

```
POLICY           N  AGREED  DIVERGED  EST. COST DELTA
priors-only      5  100%    0         +0.0000 over 4
cheapest-first   5  100%    0         +0.0000 over 4
strongest-first  5  20%     4         +2.5829 over 4

  strongest-first preferred instead: anthropic/opus-5 (4)
```

### The three baselines

| policy            | question it answers                                   |
| ----------------- | ----------------------------------------------------- |
| `priors-only`     | is learning changing any decisions at all?            |
| `cheapest-first`  | would just picking the cheapest model do as well?     |
| `strongest-first` | how much more would always using the best model cost? |

The two naive baselines are the point. RoutePilot's entire justification is that
expected-cost routing beats them, and that claim should be measured continuously
rather than asserted once in a README.

### The non-execution guarantee is structural

Not a convention:

- `ShadowRouter` is built from a model registry and a learned model. Neither can
  start a process.
- `src/core` cannot import an adapter at all — an architectural test fails the
  build.
- A shadow outcome carries a model **id**, never a session. There is nothing to
  run.

Asserted in `src/adapters/shadow-execution.test.ts`: the live policy selects
`acme/fast-1`, `strongest-first` selects `acme/deep-1`, and the executing
adapter's recorded `(request, model)` list is exactly `['acme/fast-1']`.
Evaluating more shadow policies adds no adapter calls.

### What a shadow comparison cannot tell you

**It cannot tell you a policy is better.** The shadow's model was never run, so
no outcome exists for it — and both sides of every cost delta come from the same
success probabilities, so a miscalibrated predictor shifts them together rather
than being revealed.

The report never uses the word "saving" where it carries a figure, and states
the limitation in full. Establishing that one policy is genuinely better needs
outcomes for both arms.

---

## End-to-end scenarios

Fourteen complete situations in `src/e2e/scenarios.test.ts`, each driven through
the whole pipeline: route → execute → monitor → validate → classify → escalate →
score → learn. 51 assertions.

The routing ladder passes on the specification's own wording, with **no tier
rule anywhere**:

| task                                             | routed to |
| ------------------------------------------------ | --------- |
| "Rename this variable."                          | cheap     |
| "Add a standard REST endpoint."                  | medium    |
| "Refactor authentication across the repository." | frontier  |

The assertions check _why_, not just _what_: scenario 1 checks all three models
are viable and the cheap one wins on cost; scenario 2 checks the cheap model is
genuinely **cheaper** and loses on confidence. Neither would hold if a tier
table were doing the work.

The scenarios script the _agent_, not the model — the right boundary for testing
a pipeline, and it means they say nothing about whether a real model behaves as
scripted.

---

## Performance

See [PERFORMANCE.md](PERFORMANCE.md). `npm run bench` reports the four tracked
stages and routing overhead as a fraction of estimated model execution
(0.04%–3.7%). It asserts no threshold, deliberately.

---

## Limitations

1. **Calibration is measured over a selected sample.** Only the model that ran
   has an outcome, so the scored predictions are the ones the router was
   confident enough to act on. That is the right sample for "were the
   predictions we spent money on any good" — it is **not** a measure of accuracy
   across all tasks, and nothing in the report should be read as one
   (spec section 44).
2. **No recalibration.** A distrusted predictor is withdrawn, never corrected.
   Platt scaling would repair a systematically shifted one rather than
   discarding it.
3. **No offline policy replay.** Comparing whole policies against recorded
   _outcomes_ — as opposed to recorded decisions — is not implemented.
4. **No counterfactual outcome.** Shadow history cannot feed the learning
   engine, and using it that way would be exactly the fabrication the learning
   engine is careful to avoid.
5. **In a real installation all three reports are empty**, because nothing
   executes tasks. `routepilot calibration` and `routepilot shadow` say so
   rather than showing zeros.
