# Cursor adapter

> **Status: verified, narrowly.** On 2026-09-03 the adapter ran a real task
> against Cursor CLI 2026.09.02 and returned `completed` in 33 s. That confirms
> availability detection, Windows shim resolution, process spawning, the
> stream-json event schema, event normalisation and workspace-trust handling.
>
> **It does not confirm that a real coding task works**, and the run reported
> **no usage data at all**, so Cursor costs are estimates rather than
> measurements.

RoutePilot drives Cursor through its documented CLI agent. It is a **wrapper**.

---

## How it works

```
cursor-agent --print --output-format stream-json --model <id>
```

### What is _not_ done

- **No modification of the Cursor installation** (spec section 2, rule 5).
  Nothing is patched, and no internal file is touched.
- **No undocumented traffic interception.**

---

## `cursor-agent`, not `cursor`

The Cursor **editor launcher** is a different program. Pointing this adapter at
`cursor` will open an editor window, not run an agent. The adapter's setup error
says so, because the mistake is easy and the failure is otherwise baffling.

---

## What has and has not been confirmed

Confirmed on 2026-09-03 against Cursor CLI 2026.09.02: availability detection,
version parsing, Windows shim resolution, process spawning, the stream-json
event schema, event normalisation through to a terminal `completed`, and
workspace-trust handling.

Not confirmed: usage reporting — the real run returned none — cancellation,
timeouts, failure classification from real errors, and any task requiring tool
use. The verification prompt forbids tools.

The event schema was built from the shapes named in the specification. One real
transcript has now been observed, but a single successful run is thin evidence,
so the adapter still hedges:

- both `snake_case` and `camelCase` key styles are accepted
- unrecognised events are **ignored** rather than guessed at

That hedge is a symptom of the uncertainty, not a feature. Once the schema is
confirmed, it should be narrowed.

---

## Verifying it

```bash
# install the Cursor CLI first, then:
npm run verify:adapters -- cursor-cli
```

If it runs, record the evidence in `ADAPTER_VERIFICATION` and narrow the event
parsing to what Cursor actually emits.

---

## Configuration

Cursor is an _adapter_, not a provider. Models are configured normally — see
[CONFIGURATION.md](CONFIGURATION.md). Credentials are Cursor's own; RoutePilot
neither reads nor stores them.

---

## Limitations

1. **Only a trivial, tool-free task has run.** File creation, modification,
   terminal use and test execution are all unconfirmed.
2. **No usage data was returned**, so cost for a Cursor run is priced from
   estimates rather than measured. This is a real difference from the Claude
   Code adapter, which does report usage.
3. **The event schema was guessed** from the specification and has been seen
   working exactly once. The adapter still accepts both key styles and ignores
   unrecognised events; that hedge should stay until more output is observed.
4. **On Windows the installer ships only `cursor-agent.cmd` and `.ps1`**, which
   `execFile` cannot launch without a shell. The adapter resolves the `node.exe`
   and `index.js` those wrap; see `windows-shim.ts`.
5. **The adapter passes `--trust`**, which trusts the workspace the caller
   named. It never passes `--force` or `--yolo`, which grant blanket command
   approval; a test asserts they never reach the argument list.
6. **Model ids are passed through unchanged.** Whether Cursor accepts the ids in
   your configuration is unverified.
7. **Cancellation and timeout behaviour are untested** against the real tool.
