# Failure taxonomy and the escalation graph

When an attempt fails, the expensive mistake is to reach for a bigger model. A
stronger model cannot start a database that is down, cannot clarify a request
that was ambiguous, and cannot reach a provider that is returning 503.

So RoutePilot **classifies the failure before it decides anything about it**.

---

## The failure taxonomy

Fourteen kinds, in `src/core/types/failure.ts`:

| type                  | meaning                                             | escalating helps?                        |
| --------------------- | --------------------------------------------------- | ---------------------------------------- |
| `MODEL_WEAKNESS`      | the model was not up to the task                    | **yes** — this is what escalation is for |
| `MISSING_CONTEXT`     | it did not have what it needed                      | improve context first                    |
| `BAD_SPECIFICATION`   | the task as written cannot be done                  | no — ask                                 |
| `USER_AMBIGUITY`      | the request was unclear                             | no — ask                                 |
| `REPOSITORY_PROBLEM`  | the repository was already broken                   | no                                       |
| `ENVIRONMENT_FAILURE` | database down, service unreachable, missing tool    | **no**                                   |
| `PROVIDER_FAILURE`    | the provider could not be reached                   | retry or switch provider                 |
| `TOOL_FAILURE`        | a tool call failed                                  | maybe                                    |
| `FLAKY_TEST`          | the test failed for reasons unrelated to the change | no                                       |
| `TIMEOUT`             | the run exceeded its time limit                     | maybe                                    |
| `CONTEXT_LIMIT`       | the request did not fit                             | a larger window, not a better model      |
| `BUDGET_EXCEEDED`     | a budget was exhausted                              | no                                       |
| `USER_CANCELLED`      | the user stopped it                                 | **no, and it teaches nothing**           |
| `UNKNOWN`             | none of the above could be established              | no                                       |

### Only `MODEL_WEAKNESS` updates beliefs about a model

This is architectural principle 10 and it is load-bearing. A provider outage
recorded as a model failure would corrupt the learned success rate for a model
that did nothing wrong. Every other classification is recorded as
**not model-attributable**, and the learning engine refuses it.

`USER_CANCELLED` is singled out further: a user may cancel because they changed
their mind, got interrupted, or realised the task was wrong. None of that is
evidence about the model, and treating it as a failure would punish models for
being interrupted (spec section 32).

### Classification is evidence-based, not status-based

**A successful API response does not mean the task succeeded.** An agent can
report `completed` having written code that does not compile. So the classifier
looks at:

- normalised execution events (tool failures, edit churn, terminal commands)
- the adapter's own view of how the run ended
- **post-execution validation** — did the build and tests actually pass
- how ambiguous the task was
- whether the repository was already broken before the run

That last one matters: without it, a pre-broken build gets blamed on the model.

---

## The escalation graph

Not a ladder. Eight possible actions:

| action                | when                                                       |
| --------------------- | ---------------------------------------------------------- |
| `none`                | the attempt succeeded                                      |
| `retry`               | a transient failure worth one more go at the same model    |
| `improve-context`     | the model lacked context, not capability                   |
| `escalate-vertical`   | **up a tier** — the classic case, on model weakness        |
| `escalate-horizontal` | **sideways** to a same-tier model that is better at _this_ |
| `provider-fallback`   | same model, different provider, when one is unreachable    |
| `ask-user`            | a human has to resolve it                                  |
| `stop`                | nothing further is worth spending                          |

### Vertical escalation

Up a tier, on `MODEL_WEAKNESS`. The next model is chosen by expected cost to
success among those the hard filter still permits — not simply "the next tier
up".

### Horizontal escalation

Sideways, to a same-tier model whose declared strengths fit this task better. A
model can be cheaper _and_ better at debugging than one alongside it, and moving
up a tier to get that would overpay.

A horizontal move requires a **material** advantage — the skill prior for the
task's dimension must be meaningfully higher (`HORIZONTAL_SKILL_MARGIN`, 0.1).
Without that threshold, marginal differences in configured priors would cause
pointless sideways hops.

### Human escalation

`ask-user` is a first-class outcome, not a failure path. It happens when:

- the task is ambiguous enough that another attempt is guessing
  (`USER_AMBIGUITY`, `BAD_SPECIFICATION`)
- the budget cannot be satisfied and the policy says `ask`
- escalation limits are reached with the task unfinished

The decision carries a **question**, not just a refusal. Asking clearly beats
spending money on an attempt that cannot succeed (spec section 26).

### Stopping

Escalation is bounded by four limits, all taken from configuration:

| limit                   | source                                 |
| ----------------------- | -------------------------------------- |
| `maxEscalationsPerTask` | `routing.maxEscalationsPerTask`        |
| `maxRetriesPerModel`    | `routing.maxRetriesPerModel`           |
| `maxTotalCost`          | `budgets.request`                      |
| `maxExecutionTimeMs`    | `routing.maxExecutionTimeMs`, when set |

When the strongest model fails, the answer is `stop` with a reason — never an
infinite climb. A run that exhausts its limits says which limit it hit.

The cost limit is applied **before** the next attempt, not after it. The runner
projects what the next model is expected to cost and stops if that would take
the total past the request budget. Otherwise the budget would bound only the
first attempt, and across retries and escalations a task could spend several
multiples of it.

### Escalation never lowers the bar

Escalation moves only between models the router marked **viable** — those that
met the confidence threshold, the risk cap, the latency cap and the budget. A
model the router evaluated and rejected is not a fallback; it is a rejected
model, and a vertical escalation cannot reach for it because the cheap rung
failed. Escalation widens which _acceptable_ model runs next. It never lowers
the bar, which is the same rule exploration is held to.

---

## The handoff

An escalated model receives a **compact briefing**, never a transcript
(spec section 28):

- the original task, unchanged
- one line per previous attempt
- files already changed, and files already read
- validation checks known to be failing
- approaches already tried, so they are not repeated blindly
- why the task is being handed over

In the end-to-end scenario suite this measures under 2 KB. A transcript would be
orders of magnitude larger, would cost real money to re-read, and would bury the
one thing the next model needs to know.

The briefing is flattened to a string at exactly one boundary, so the adapter
interface never learns RoutePilot's internal handoff shape.

---

## Worked example

From `src/e2e/scenarios.test.ts`, scenario 4:

```
1. Cheap model runs.       Reports "completed".
2. Validation runs.        Tests fail.  ← the status code lied
3. Classification.         MODEL_WEAKNESS (repeated tool failures, edit churn)
4. Escalation decision.    escalate-vertical -> medium model
5. Handoff built.          Names the previous model, the failing check,
                           the changed files. Under 2 KB.
6. Medium model runs.      Tests pass.
7. Outcome scored.         Cost includes both attempts.
```

And scenario 5, the one that matters most for spend:

```
1. Model runs.             Fails: cannot connect to postgres.
2. Classification.         ENVIRONMENT_FAILURE
3. Escalation decision.    NOT escalate-vertical.
                           No stronger model is ever asked to run.
4. Every escalation record is marked not model-attributable.
```

---

## Limitations

1. **Escalated tasks teach nothing.** After a handoff there is no honest way to
   say whose work produced the result, so the learning engine discards the
   outcome entirely. The more RoutePilot escalates, the less it learns.
2. **`improve-context` is decided but not acted on.** The action exists and can
   be returned; nothing re-plans the context and retries with more.
3. **Classification confidence is reported but not used to gate.** A
   low-confidence `MODEL_WEAKNESS` escalates exactly like a high-confidence one.
4. **Provider fallback needs more than one provider serving a model**, which the
   example configuration does not have.
