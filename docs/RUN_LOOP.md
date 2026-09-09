# The run loop

What `routepilot run --execute` actually does, and what has been observed doing
it.

**Status: verified** on 2026-09-09 against Claude Code 2.1.72, driving a real
agent through the production path end to end. First verified 2026-09-08; re-run
after Phase 27 changed what an outcome may claim, and again after Phase 28 added
prediction recording.

---

## What the loop is

Every other verification in this project covers one component. This covers the
seams between them:

```
routeTask()            classify, analyse, extract features, route
     ↓
runTask()              the production entry point the CLI calls
     ↓
TaskRunner             attempts, limits, escalation decisions
     ↓
RegistryExecutor       adapter selection, retry, fallback, event collection
     ↓
a real coding agent    edits files in a real workspace
     ↓
ValidationEngine       runs the workspace's own manifest scripts
     ↓
outcome + telemetry + learning
```

Each of those was tested in isolation and none of it was tested together.

## Why that mattered

The first end-to-end run found a defect that every unit test missed, and it was
not a small one.

Validation commands are derived from the workspace's own `package.json`
scripts, so every one of them is `npm run <script>`. On Windows npm is
`npm.cmd`, Node's `execFile` refuses to launch a `.cmd` without a shell, and
`docs/SECURITY.md` forbids `shell: true` because this project spawns processes
with values that came from a user's prompt.

So on Windows **every validation command failed to start**. Each check reported
"not run", `evaluated` was false, and every `routepilot run --execute` reported
`unverified` no matter what the agent had done. The engine that exists to stop
RoutePilot believing an agent's own word could not run at all on that platform.

Nothing caught it because every unit test injects a fake command runner, and
`scripts/verify-agent-tasks.mjs` calls `adapter.execute` directly — bypassing
`TaskRunner`, and with it validation, entirely.

`src/infra/npm-command.ts` resolves npm's JavaScript entry point and runs it
with `process.execPath`, the same approach `src/adapters/cursor/windows-shim.ts`
already uses for the same reason.

## What was verified

Seven checks against `https://api.anthropic.com` via Claude Code, on Windows with
Node 22.18.0, using `claude-haiku-4-5` and `--permission-mode acceptEdits`:

| check                                         | what it proves                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------ |
| plans without touching the workspace          | the safe default holds through the real path                                         |
| the full loop succeeds against a real agent   | routing → executor → adapter → real edits → real validation → `succeeded`            |
| the outcome was earned by a check that ran    | `succeeded` came from a verdict, not the agent's word, and no criterion was invented |
| the run reached the telemetry database        | a real run is recorded                                                               |
| the outcome became a learned observation      | the last link in the record-then-learn loop                                          |
| the prediction was scored against the outcome | a calibration row reaches SQLite; every run before 2026-09-09 recorded none          |
| reports `unverified` when nothing can check   | the honesty path, against a real agent                                               |

Every assertion observes the filesystem or the SQLite database. Recorded in
`.routepilot/run-loop-verification.json`, written by the script.

The third check is where Phase 27 shows up. It requires `testsPassed=true` **and
`taskCriteriaMet=null`** — real evidence present, invented evidence absent. The
2026-09-08 run recorded `taskCriteriaMet=true` and `evidence=0.5`; this one
records `null` and `0.3`, and the 0.2 between them is exactly the circular claim
that was removed. The passing test suite is unchanged, and still trains the
router.

The sixth check is where Phase 28 shows up. `predictionFromDecision` and
`recordPredictions` were built in Phase 11 and neither had a production caller,
so every real run before this one left the prediction table empty and the
calibration safeguard could never reach a verdict. This run recorded
`predicted=0.871, actual=1, source=prior`.

That `source=prior` is the honest caveat: the safeguard scores only `learned`
predictions, so a default install with learning off records rows the gate
ignores by design. Calibration is now waiting on data rather than structurally
impossible, which is not the same as saying it fires.

### Limitations: what was not verified

**Escalation has still never happened for real.** It remains the largest gap.
There is a structural reason this fixture cannot close it:
`weakness.broke-validation` requires `repositoryBrokenBeforeRun !== true`, and
the fixture ships with a _failing_ test — correctly, since a model that fails to
fix an already-broken repository has not broken anything. Triggering a real
vertical escalation needs a second fixture that starts passing plus a model that
reliably fails it, which is not deterministic.

Also unverified: budget enforcement across real attempts, retry and provider
fallback against a real agent, and the loop on any platform other than Windows.

## Reproducing it

```
npm run verify:run-loop -- --model anthropic/haiku --permission-mode acceptEdits
```

Options: `--adapter` (`claude-code` or `cursor-cli`), `--model`, and
`--permission-mode`. Claude Code needs `acceptEdits` to write files at all —
see [CLAUDE_CODE.md](CLAUDE_CODE.md).

This spends real quota and lets a real agent write files. Everything it can
touch is a fresh directory under the system temp directory containing four
files worth nothing. Your repository is never the workspace.

Exit code 0 means every check passed.
