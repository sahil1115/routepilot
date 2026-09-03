# Claude Code adapter

> **Status: unverified.** Availability detection has been confirmed against a
> real install. **Execution has never been run.** Nothing on this page describes
> observed behaviour unless it says so explicitly.

RoutePilot drives Claude Code through its documented non-interactive CLI. It is
a **wrapper**, not an interception layer.

---

## How it works

```
claude --print <prompt> --output-format stream-json --verbose --model <id>
```

Those flags were read from `claude --help` on **version 2.1.72**, not recalled
from memory. The adapter parses the resulting stream-json events and normalises
them onto RoutePilot's ten event kinds.

Two flags discovered on that same install and worth knowing about:
`--max-budget-usd` and `--fallback-model`.

### What is _not_ done

- **No traffic interception.** Transparent interception of Claude Code's
  requests is not implemented and is not claimed.
- **No modification of Claude Code internals** (spec section 2, rule 6). Nothing
  is patched, injected or replaced.

---

## What has and has not been confirmed

| aspect                                     | status                                     |
| ------------------------------------------ | ------------------------------------------ |
| availability detection                     | **confirmed** against Claude Code 2.1.72   |
| version parsing                            | **confirmed** — reported the right version |
| execution                                  | not confirmed                              |
| streaming and the stream-json event schema | not confirmed                              |
| usage reporting                            | not confirmed                              |
| cancellation                               | not confirmed                              |
| timeout behaviour                          | not confirmed                              |

Everything in the second group is covered by stub-process tests. Those prove the
adapter handles the shapes it was _told_ to expect — not that those are the
shapes Claude Code emits.

---

## Verifying it

```bash
npm run verify:adapters -- claude-code
```

**Run this from a plain terminal.** Claude Code refuses to run nested inside
another Claude Code session, and the tool warns that attempting it "will crash
all active sessions". The verification script therefore refuses to start when
`CLAUDECODE` is set, rather than risking someone's live session.

If the run succeeds, record what was observed in `ADAPTER_VERIFICATION` — date,
tool version, and what actually happened — and move the status to `verified`. A
test enforces that `verified` requires that evidence.

---

## Windows

Node refuses to spawn `.cmd` and `.bat` files without a shell, which is
deliberate hardening against argument injection. RoutePilot does **not** enable
a shell to work around it (spec section 51). Instead the adapter supports a
`commandArgs` prefix, and its setup error explains the shim on Windows.

---

## Configuration

Claude Code is an _adapter_, not a provider. Models are configured normally —
see [CONFIGURATION.md](CONFIGURATION.md) — and the adapter is selected at
execution time. Credentials are Claude Code's own; RoutePilot neither reads nor
stores them.

---

## Limitations

1. **Execution has never been run.** Availability and version detection are
   confirmed; everything else is covered only by stub-process tests.
2. **The stream-json event schema is assumed, not observed.** The adapter
   handles the shapes it was told to expect. Whether Claude Code emits those
   shapes is unverified.
3. **Usage reporting is unverified**, so cost figures for a real run would be
   estimates rather than measurements.
4. **Flags are pinned to what version 2.1.72 documented.** A future version that
   renames or removes one would break the adapter, and nothing detects that
   beyond the run failing.
5. **Nested execution is impossible to verify from inside an agent session**, so
   confirming this adapter needs a human at a plain terminal.
