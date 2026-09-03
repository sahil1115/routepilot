# Integrations

RoutePilot chooses a model. Something else runs it. That something is an
**adapter**.

> **No adapter has been verified against its real tool.** This is the oldest
> open item in the project and the most important thing on this page. Details
> below, and in `src/adapters/verification.ts`, which is the authoritative
> record.

---

## The adapter model

Every coding agent reaches the core through one provider-neutral interface
(`src/core/types/agent.ts`). The router never learns which tool is installed.

```ts
interface AgentAdapter {
  readonly id: string;
  readonly capabilities: AgentCapabilities;

  canHandle(request): AgentSupportDecision;
  execute(request, model): Promise<AgentSession>;
  cancel(sessionId): Promise<void>;
  getStatus(): Promise<AgentStatus>;

  normalizeEvent(raw): AgentEvent | null; // native output -> ten event kinds
  normalizeResult(raw): AgentResult;
}
```

Every native event is normalised into one of ten kinds — `tool-call`,
`file-change`, `usage`, `error`, `completed`, and so on — before the core sees
it. The execution monitor, the struggle score and most of the failure taxonomy
are built on that normalised stream.

### Two rules that constrain every adapter

1. **No undocumented hacks.** An adapter wraps a documented CLI or a documented
   HTTP API. No traffic interception, no patching another tool's files
   (spec section 2, rules 4–6).
2. **Nothing is "supported" until it has been run for real** (rule 20). The
   verification table below is the record, and `routepilot status` prints it.

---

## Verification status

| adapter           | status          | what that means                                                                 |
| ----------------- | --------------- | ------------------------------------------------------------------------------- |
| `claude-code`     | **unverified**  | implemented; availability confirmed against a real install, execution never run |
| `cursor-cli`      | **unavailable** | implemented; `cursor-agent` is not installed here, so nothing is confirmed      |
| `direct-provider` | **unverified**  | implemented; needs a concrete protocol and credentials                          |
| `fake`            | verified        | a scripted adapter with no external tool to be wrong about                      |

Check it yourself:

```bash
routepilot status              # includes the table
npm run verify:adapters -- claude-code
```

The verification script **refuses to run inside a Claude Code session**, because
Claude Code will not run nested and the attempt would disrupt the session.

See [CLAUDE_CODE.md](CLAUDE_CODE.md) and [CURSOR.md](CURSOR.md) for the
per-adapter detail.

---

## The retry and fallback chain

`AgentRegistry.execute` handles what happens _below_ the router:

1. Ask the preferred adapter whether it `canHandle` the request.
2. Run it, retrying with backoff on a transient failure.
3. On a persistent failure, try other adapters in deterministic id order.
4. Report every attempt, and every adapter skipped, with a reason.

Above that, the **task runner** handles what happens when the model itself was
the problem — classification, escalation, handoff. The two layers are separate
because "the provider is down" and "this model is not good enough" call for
completely different responses. See [ESCALATION.md](ESCALATION.md).

### Events must not be discarded

`AgentRegistry.execute` takes an `onEvent` hook, and the executor that drives it
uses it. This is not optional plumbing: an executor that consumed the stream and
threw it away would silently disable struggle detection and half the failure
taxonomy, and every test would still pass. That was a real bug, found while
wiring the task runner.

---

## Writing an adapter

1. Implement `AgentAdapter` in `src/adapters/<name>/`.
2. Map native events onto `AgentEvent` in `normalizeEvent`. Return `null` for
   anything the core should ignore rather than inventing a shape.
3. Report `getStatus()` honestly — an unavailable tool must produce a message
   that says how to fix it.
4. Add an entry to `ADAPTER_VERIFICATION` with status `unverified`, the
   mechanism, how to verify it, and its known limitations.
5. Only move it to `verified` after running it against the real tool, and record
   the evidence — date, tool version, what was observed. A test enforces that
   `verified` requires evidence.

---

## What RoutePilot never does

- **Modify another tool's installation.** No patching Cursor, no patching Claude
  Code (rules 5 and 6).
- **Intercept traffic.** The Claude Code adapter is a CLI wrapper and says so.
  Transparent interception is not implemented and is not claimed.
- **Commit your code.** Ever (rule 13).
- **Send source anywhere it was not already going.** See [PRIVACY.md](PRIVACY.md).

---

## Limitations

1. **No adapter is verified.** Everything above describes code that compiles,
   is tested against stub processes, and has never moved a byte to a real model.
2. **No `routepilot run` command.** The task runner exists and is exercised end
   to end against scripted executors, but no CLI command drives it against a
   real adapter — because doing so would ship an unverified path.
3. **The Cursor adapter's event schema is guessed** from the specification's
   description, not confirmed against real output. It accepts both snake_case
   and camelCase keys as a hedge.
4. **`direct-provider` has no bundled protocol.** It is a transport; the request
   and response encoding must be supplied per provider.
