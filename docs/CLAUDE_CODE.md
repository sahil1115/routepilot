# Claude Code adapter

> **Status: verified, narrowly.** On 2026-09-03 the adapter ran a real task
> against Claude Haiku 4.5 through Claude Code 2.1.72 and returned `completed`.
> That confirms availability detection, process spawning, the stream-json event
> schema, event normalisation and usage reporting.
>
> **It does not confirm that a real coding task works.** The verification prompt
> forbids tool use, so nothing has yet asked this adapter to edit a file. See
> [Permissions](#permissions), which is the reason to expect that it may not.

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
| execution                                  | confirmed 2026-09-03, tool-free task only  |
| streaming and the stream-json event schema | confirmed 2026-09-03                       |
| usage reporting                            | confirmed: 10 in / 40 out / 0 cached       |
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

## Permissions

**With no `--permission-mode`, Claude Code cannot write files in print mode —
and does not say so.** Observed on 2026-09-04 against 2.1.72, running
`npm run verify:agent-tasks -- claude-code`:

| task                     | result                                           |
| ------------------------ | ------------------------------------------------ |
| task                     | no permission mode                               | `acceptEdits` |
| ------------------------ | ------------------------------------------------ | ------------- |
| fix a failing test suite | **FAIL** — refused, source unchanged             | **PASS**      |
| create a file            | **FAIL** — refused, file not created             | **PASS**      |
| report on a missing file | PASS — read-only, and did not fabricate it       | PASS          |
| cancel mid-run           | PASS — reported `cancelled`                      | PASS          |

**With `acceptEdits`, all four pass.** Without it, two do.

The cause is not ambiguous. Each `Edit` and `Bash` tool result came back with
`is_error: true` while `Read` and `Glob` succeeded, and the model said so in
plain text: _"The system is asking for permission to edit the file."_ Claude
Code cannot prompt in print mode, so it declines and carries on.

### The failure used to look like a success

Claude Code emits a terminal `subtype: "success"` even when it was refused
throughout, and the adapter relayed that as `status: completed`. A caller
trusting the verdict would have recorded a task that changed nothing as done.

The adapter now reports `failed` with `ENVIRONMENT_FAILURE` when tool calls were
refused and no file changed. Not `MODEL_WEAKNESS`: the model was never permitted
to try, and scoring it as weakness would teach the router to avoid a model on
the strength of a configuration mistake.

### What to do about it

The adapter passes no permission mode by default and will not start doing so.
RoutePilot does not widen a user's permissions on their behalf, and the modes
are not equivalent:

| mode                         | scope                                |
| ---------------------------- | ------------------------------------ |
| `acceptEdits`                | accepts file edits without prompting |
| `bypassPermissions`          | grants everything                    |
| `plan`                       | forbids edits entirely               |
| `default`, `dontAsk`, `auto` | the tool's own behaviours            |

Only `acceptEdits` is scoped to the thing being asked for. `bypassPermissions`
is the counterpart of Cursor's `--yolo`, which this project refuses for the same
reason. Set one deliberately:

```jsonc
"agents": {
  "claude-code": { "permissionMode": "acceptEdits" }
}
```

Verified on 2026-09-04 against 2.1.72: with that setting the four fixture tasks
score 4/4, and the file-modification task's own test suite passes afterwards.
Reproduce it from a plain terminal with:

```
npm run verify:agent-tasks -- claude-code --permission-mode acceptEdits
```

---

## Limitations

1. **Writing requires a permission mode** — see [Permissions](#permissions).
   This is the limitation most likely to matter for a real coding task, and
   RoutePilot will not choose a mode on your behalf.
2. **`changedFiles` is a lower bound.** It is built from `Edit`, `MultiEdit`,
   `Write` and `NotebookEdit` calls whose own result came back successful,
   correlated by tool-use id because Claude Code issues calls in parallel.
   `Bash` can write anything and reports no path, so its writes are invisible.
3. **Timeout behaviour is unconfirmed** against the real tool and is covered
   only by stub-process tests. Cancellation is confirmed.
4. **Flags are pinned to what version 2.1.72 documented.** A future version that
   renames or removes one would break the adapter, and nothing detects that
   beyond the run failing.
5. **Claude Code refuses to run nested inside another Claude Code session.**
   Clearing `CLAUDECODE` and `CLAUDE_CODE_ENTRYPOINT` in the child's environment
   lifts the refusal, which is how the 4/4 run above was obtained. A plain
   terminal works too and needs no workaround.
