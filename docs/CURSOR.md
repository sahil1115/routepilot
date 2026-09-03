# Cursor adapter

> **Status: unavailable.** `cursor-agent` is not installed on the machine this
> was developed on, so **nothing** about this adapter has been confirmed against
> the real tool — not even availability detection.

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

Nothing has been confirmed. The tool is not installed here.

The event schema is built from the shapes named in the specification. Because it
has not been checked against real output, the adapter hedges:

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

1. **Nothing is confirmed.** `cursor-agent` is not installed on the development
   machine, so not even availability detection has been observed working.
2. **The event schema is guessed** from the specification's description. The
   adapter accepts both key styles and ignores unrecognised events as a hedge;
   that hedge should be removed once real output is available.
3. **Model ids are passed through unchanged.** Whether Cursor accepts the ids in
   your configuration is unverified.
4. **Cancellation and timeout behaviour are untested** against the real tool.
