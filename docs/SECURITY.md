# Security

RoutePilot spawns processes, reads repositories, spends money and holds no
secrets of its own. This is what it does about each of those.

---

## Process execution

Every external process is spawned with `execFile` and an **argument array** —
never a command string, never a shell.

```ts
// what RoutePilot does
run('git', ['status', '--porcelain=v1', '--', '.'], { shell: false });

// what it never does
exec(`git status ${userSuppliedPath}`);
```

No user-supplied string is ever concatenated into a command line, so there is no
shell metacharacter to escape and no injection to get wrong (spec section 51).

### The Windows case, and why no exception was made

Node refuses to spawn `.cmd` and `.bat` files without a shell. That refusal is
deliberate hardening — those file types re-parse their arguments, which is
exactly the injection vector `shell: false` exists to close.

RoutePilot **does not enable a shell to work around it.** Adapters support a
`commandArgs` prefix instead, and the setup error explains the shim. Convenience
did not win.

---

## Command timeouts

Every spawned process has a timeout. A validation command that hangs is
abandoned and reported as _not run_ — which is different from _failed_, and the
distinction is preserved all the way into the outcome score, because a check
that could not run must not count against a model.

---

## Credentials

RoutePilot **never holds a credential.** A provider names an environment
variable:

```jsonc
{ "auth": { "kind": "apiKey", "envVar": "ANTHROPIC_API_KEY" } }
```

- The value is never read into a configuration object.
- It is never written to telemetry — there is no field for it.
- `routepilot status` reports whether the variable is _set_, never its value.
- Adapter credentials belong to the adapter's own tool. RoutePilot does not read
  Claude Code's or Cursor's authentication.

Anything that could carry a secret into a log or the UI passes through
`redact()` first. See [PRIVACY.md](PRIVACY.md).

---

## Network

RoutePilot makes **no network call of its own**. There is no telemetry endpoint,
no update check, no license server.

The only outbound traffic is a coding agent talking to the provider you
configured — traffic that would have happened anyway.

Any local server binds to **localhost** by default and is never exposed publicly
without explicit configuration.

---

## Filesystem

- Repository analysis is **read-only**. The `FileSystemPort` the analyzer
  depends on has no write method, so it cannot modify a workspace even by
  mistake.
- Absolute paths are stripped before storage.
- RoutePilot **never commits your code** (architectural principle 13).

---

## Untrusted workspace settings

A `.vscode/settings.json` arrives with a repository — through a clone, a branch,
or a pull request from a stranger — and VS Code applies it without ceremony.

So editor settings may make RoutePilot **more** careful and never less:

| setting                                | allowed direction                        |
| -------------------------------------- | ---------------------------------------- |
| `routepilot.requestBudget`             | may lower the budget, never raise it     |
| `routepilot.minimumSuccessProbability` | may raise the threshold, never lower it  |
| `routepilot.exploration.enabled`       | may switch exploration **off**, never on |
| `routepilot.operationMode`             | may become stricter, never laxer         |

Without that asymmetry, opening an untrusted repository would be enough to turn
on experiments and remove a spending cap. Refusals are reported to the user
rather than silently dropped.

---

## Spending

Money is a security concern here, because the failure mode is unbounded cost.

- The request budget is **enforced**. RoutePilot never silently exceeds it: it
  asks, stops, or falls back, and says which (principle 7).
- Escalation is bounded by `maxEscalationsPerTask` and `maxRetriesPerModel`.
  A run that exhausts them stops with a reason rather than climbing forever.
- Exploration is capped by `maxCostPremium` — the price of information, bounded.
- `--mode` defaults to **production**, which forbids exploration. Forgetting the
  flag can only suppress an experiment, never authorise one. A typo is a hard
  error.

> **`session`, `daily` and `monthly` budgets are validated and displayed but
> NOT enforced.** Only `request` is applied. This is the most significant known
> gap on this page.

---

## Destructive and production work

Exploration — deliberately trying a model RoutePilot does not believe is best —
is refused outright on any task carrying a hazard: `destructive`, `production`,
`security`, `credentials`, `payments`, `data-migration`.

The refusal matches on the **hazard**, not on the risk score. A destructive task
that happens to score low is still destructive, and a threshold on the number
alone would wave it through.

---

## Supply chain

One runtime dependency: `zod`. The SQLite driver is Node's own `node:sqlite`,
chosen partly so there is no native module in the tree.

---

## Reporting a problem

This is an unreleased, unlicensed project with no security contact. If you are
evaluating it, treat the limitations below as the current state rather than as
oversights awaiting a patch.

---

## Limitations

1. **`session`, `daily` and `monthly` budgets are not enforced.** A long session
   can exceed them without RoutePilot noticing.
2. **No adapter has been verified against its real tool**, so the process-spawning
   paths described above are exercised only against stub processes.
3. **Redaction is pattern-based.** It catches the credential shapes it knows;
   an unusual format could survive. The real defence is having nowhere to store
   one.
4. **No dependency audit or pinning policy** beyond a lockfile.
5. **The VS Code extension has never been run in VS Code**, so the settings
   narrowing described above is verified against a fake host only. See
   [EXTENSION.md](EXTENSION.md).
6. **RoutePilot trusts its configuration file.** A malicious `routepilot.config.json`
   could point at a hostile endpoint. It is treated as trusted input, like any
   other config file in a repository you have chosen to open.
