# The direct provider adapter

Calls a provider's HTTP API directly, without a coding agent in between.

**Status: verified** against the Anthropic Messages API on 2026-09-06, using
`anthropic-version 2023-06-01`.

---

## What it is

RoutePilot's other two adapters drive a coding agent — a CLI that reads files,
runs commands and edits code. This one does not. It sends a request to a
provider's API and streams the response back.

That makes it the right tool for work a model can do by answering, and the wrong
tool for work that needs a workspace. `capabilities.agenticExecution` is
`false`, and `canHandle` refuses any request that needs it, so a task that must
edit files can never be routed here by mistake.

## How it is split

The adapter owns everything generic: endpoint, authentication, timeout, retry,
cancellation, streaming, and credential redaction. The vendor-specific half is a
`ProviderProtocol` you supply — three functions that encode a request and decode
the response.

```ts
interface ProviderProtocol {
  readonly id: string;
  encodeRequest(request, model): ProviderRequest;
  decodeEvent(chunk: string): AgentEvent | null;
  decodeResult(chunks: readonly string[]): AgentResult;
}
```

The split exists because transport genuinely is generic and request shapes
genuinely are not. Writing one "generic" encoder would mean inventing an API no
provider implements.

**One protocol ships**: `anthropicMessagesProtocol`. Every other provider needs
its own. Verified here means the transport works and one vendor mapping is
correct — not that another provider will work.

## What was verified

Four checks, all passing, against `https://api.anthropic.com` on Windows with
Node 22.18.0, calling `claude-opus-5`:

| check                                                    | result                        |
| -------------------------------------------------------- | ----------------------------- |
| availability reported without a network call             | PASS                          |
| missing credential → `ENVIRONMENT_FAILURE`, nothing sent | PASS                          |
| real streamed request completes and reports usage        | PASS — 2156 ms, 16 in / 4 out |
| unknown model → `PROVIDER_FAILURE`, error redacted       | PASS — 404, no key in summary |

The streamed request produced event kinds `usage`, `assistant-message`,
`completed`, in that order.

Recorded in `.routepilot/direct-provider-verification.json`, written by the
script rather than by hand.

### What was not verified

A few tokens of plain text is a narrow thing to have proven. Still unconfirmed:

- tool use and structured output;
- long streams, and streams interrupted part-way;
- cancellation mid-request, and timeout behaviour against the real endpoint;
- every provider other than Anthropic.

## Running it yourself

Verification needs a real credential, so it sits outside `npm run verify` and
never runs in CI.

```powershell
$env:ANTHROPIC_API_KEY = "..."      # PowerShell
export ANTHROPIC_API_KEY="..."      # bash
npm run verify:direct
```

Options: `--model <id>` (default `claude-opus-5`) and `--env-var <NAME>`
(default `ANTHROPIC_API_KEY`).

Cost is a few short requests — well under a cent.

## The credential

Configuration names the **environment variable**, never the value. The schema
enforces it: `auth.envVar` must match `^[A-Z][A-Z0-9_]*$`, and anything else is
rejected with _"must be an environment variable NAME, not a credential value"_.

```jsonc
"providers": [
  {
    "id": "anthropic",
    "endpoint": "https://api.anthropic.com",
    "auth": { "kind": "apiKey", "envVar": "ANTHROPIC_API_KEY" }
  }
]
```

From there:

- the adapter reads the variable and puts the value in a header — never in the
  body, which a test asserts;
- the protocol never sees it, and a test asserts the request it builds carries
  no `x-api-key`, no `authorization`, and nothing matching `sk-ant`;
- `getStatus()` reports the variable's **name** when it is unset, so the fix is
  obvious without the value ever being printed;
- errors pass through `redactSummary`, which knows credential shapes including
  `sk-ant-`, bearer tokens and JWTs;
- the verification script scans everything it printed and recorded for the key
  and **refuses to write its report** if it finds it.

Never pass a credential as a command-line argument. It would land in your shell
history and the process list, where none of the above reaches it.

## Failure classification

The distinction matters because it feeds escalation and learning (spec section
22).

| situation                                  | classification                                 |
| ------------------------------------------ | ---------------------------------------------- |
| environment variable unset, or no endpoint | `ENVIRONMENT_FAILURE` — nothing is sent        |
| HTTP error from the provider               | `PROVIDER_FAILURE`                             |
| stream ends before `message_stop`          | `PROVIDER_FAILURE` — never reported as success |
| the model declines on policy               | a failure, but **never** `MODEL_WEAKNESS`      |
| request cancelled or timed out             | `USER_CANCELLED`                               |

A refusal says nothing about a model's ability, so scoring it as weakness would
teach the router to avoid a model over a policy decision.

## Streaming

Server-sent events are line-oriented, and the adapter delivers them as chunks
arrive rather than buffering the response. `decodeEvent` receives one line at a
time; `event:` framing lines return `null`, and `data:` lines carry the payload.

An injected client that exposes only `text()` — as test fakes do — falls back to
buffering. That is correct, but it is not streaming, and the fallback exists so
fixtures keep working rather than as the normal path.
