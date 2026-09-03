# Privacy

RoutePilot's default posture: **everything stays on your machine, and source
code is never stored.**

There is no telemetry endpoint. There is no account. There is no network call
RoutePilot makes on its own behalf — the only outbound traffic is a coding agent
talking to the provider you configured, which it would have done anyway.

---

## What is stored

A local SQLite database, by default at `~/.routepilot/routepilot.sqlite`.

| table                | what it holds                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `requests`           | task type, scope, prompt **length** and **hash**, repository hash, file count, token estimates |
| `routing_decisions`  | which model was chosen, the policy in force, candidate counts                                  |
| `routing_candidates` | per-model scores: success probability, expected cost, risk                                     |
| `attempts`           | model, adapter, duration, status, failure type, cost, token counts                             |
| `execution_events`   | event kind, tool name, ok/failed, workspace-relative path                                      |
| `escalations`        | from-model, to-model, action, reason                                                           |
| `outcomes`           | per-dimension pass/fail, score, cost, latency                                                  |
| `user_signals`       | accepted, cancelled, reverted, re-prompted                                                     |
| `learned_success`    | model id, task type, scope, three numbers                                                      |
| `predictions`        | predicted probability, actual outcome, source                                                  |
| `shadow_decisions`   | what an alternative policy would have chosen                                                   |

## What is never stored

By default (`privacyMode: "strict"`) RoutePilot does **not** store:

- source code
- prompts — only their length and a stable hash
- model responses
- API keys, tokens, passwords, private keys
- `.env` contents
- absolute paths

The record types in `src/core/types/telemetry.ts` **have no field to put them
in**. That is the primary defence: not a filter that could be bypassed, but an
absence of anywhere for the data to go.

---

## Redaction, and why it is not the primary defence

Some fields legitimately carry prose — an error summary, a failure reason. Those
pass through `redact()` before they reach disk, which:

1. replaces credential shapes (API keys, bearer tokens, `password=`, private key
   blocks) with `[REDACTED]`
2. strips absolute paths, keeping the basename: `C:\Users\me\src\a.ts` →
   `…/a.ts`

The second rule exists because a leak was found by running the store for real
rather than by reading the code: absolute paths were reaching disk **inside
error prose**, where the path-field guard could not see them. The fix was
verified by writing a record containing both an API key and an absolute path and
then grepping the raw database file: neither present, `a.ts` retained.

Redaction is defence in depth. The reason nothing serious leaks is that there is
no field for it.

---

## The user interface

The same rule applies to anything on screen. Every string that can reach a
tooltip, a panel, a notification or an output channel is redacted **at
construction**, not at display, so a new call site cannot forget — and the
property is testable in one place.

Verified three ways: unit assertions on every surface a view exposes, and
end-to-end checks that plant an API key in a task prompt, in a configuration
file, and in a chat prompt, then scan everything the extension recorded.

---

## Switching it off

```jsonc
"telemetry": { "enabled": false }
```

RoutePilot works fully with telemetry off (architectural principle 17). The
SQLite driver is not even imported. What you lose is learning, calibration and
shadow reporting, all of which need recorded outcomes.

`privacyMode: "debug"` retains more detail. It must be an explicit, informed
choice; `strict` is the default.

---

## Reading and deleting your data

It is a SQLite file. Open it with any SQLite tool; delete it to erase
everything. RoutePilot will create a fresh one.

A corrupt database is quarantined to `*.corrupt-<timestamp>` and a new one
started — routing is unaffected, because telemetry is an observer and must never
fail a task.

---

## What RoutePilot never does

- **Upload source code.** Not automatically, not ever (spec section 33).
- **Send anything to a remote learning service.** There isn't one
  (architectural principle 14).
- **Commit your code** (principle 13).
- **Log a secret** (principle 34).
- **Bind to a public interface.** Any local server binds to localhost by default
  and is never exposed without explicit configuration.

---

## Limitations

1. **A prompt hash is not anonymity.** The same task always hashes the same way,
   so someone with the database and a guess at the prompt could confirm it. The
   hash exists to group repeated tasks, not to protect their content.
2. **`privacyMode: "debug"` is not audited here.** The strict path is what has
   been checked byte-for-byte against the database file.
3. **Adapters see everything.** RoutePilot hands a coding agent your prompt and
   your workspace path; what that agent sends onward is governed by that tool's
   privacy policy, not this one.
4. **Redaction is pattern-based.** It catches the credential shapes it knows.
   A secret in an unusual format could survive — which is why the real defence
   is having no field to store it in.
