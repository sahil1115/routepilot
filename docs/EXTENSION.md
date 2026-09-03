# The VS Code extension

> **Status: built, packaged, installed, and run in a real VS Code extension
> host.** Verified on VS Code 1.136.0 (Node 24.18.1) on Windows: 8/8 checks,
> including activation, command registration, loading the ESM core inside the
> CommonJS host, and routing a task end to end. Reproduce with
> `npm run verify:vscode`. What is still unverified is stated under
> [Known limitations](#known-limitations).

RoutePilot's extension shows which model would handle a task, what it is
estimated to cost, and why. It **chooses a model; it does not run one** — the
coding agent you already use does the work.

---

## What was verified, and how

Phase 14 lists seven validation items. They are not equally checkable from a
repository with no editor attached, so each is recorded with the evidence that
actually exists.

| #   | Validation item              | Status                           | Evidence                                                                                                                                                                                                    |
| --- | ---------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | extension builds             | **Verified**                     | `npm run build:extension` — TypeScript compiles the shell against the real `dist/` declarations, so a core signature change breaks the build                                                                |
| 2   | extension installs           | **Partly verified**              | `npm run package:extension` produces `routepilot.vsix` (492 files). The archive was extracted and its `out/core.js` loaded the core successfully from the installed layout. **Not installed into VS Code.** |
| 3   | commands work                | **Verified against a fake host** | 19 checks in `extension/scripts/verify-extension.cjs` drive every registered command and assert on what the widgets received                                                                                |
| 4   | cancellation works           | **Verified against a fake host** | A cancelled progress token stops the run, reports `cancelled` rather than an error, and leaves no stale decision behind                                                                                     |
| 5   | UI remains responsive        | **Argued, not measured**         | Every expensive step is `await`ed inside `withProgress` with a live cancellation token, and the pure layer does no I/O. Responsiveness itself was not observed.                                             |
| 6   | router failure shown cleanly | **Verified against a fake host** | An invalid configuration produces an error notification with no stack trace and an error state in the status bar                                                                                            |
| 7   | no secrets in UI/logs        | **Verified twice**               | 8 assertions in `src/extension/presenter.test.ts` and `chat.test.ts`, plus 3 end-to-end checks that plant a key in a task, a config file and a chat prompt and scan every recorded surface                  |

### What "verified against a fake host" means

`extension/scripts/fake-vscode.cjs` implements the slice of the VS Code API the
shell uses and **records** every value pushed into a widget. The verification
script intercepts `require('vscode')`, loads the real compiled extension, and
asserts on what a user would have seen.

That is a real test of the extension's behaviour. It is **not** a test of VS
Code. It cannot show that the manifest's contribution points are accepted, that
the chat participant appears, that a status bar entry renders, or that the host
calls `activate` when expected.

### What nobody has done

**Nobody has installed this extension and used it.** Every claim above comes
from automated checks. The following need a person with VS Code open:

- Install `extension/routepilot.vsix` and confirm the extension activates.
- Confirm the five commands appear in the palette under **RoutePilot**.
- Confirm the status bar entry renders, and that its tooltip is readable.
- Confirm `@routepilot` appears in the chat view and answers.
- Confirm the settings appear under **Settings → Extensions → RoutePilot**.
- Confirm the UI stays responsive while a large repository is analysed.

Until someone does, this is an extension that builds, packages, loads and passes
its own checks — which is not the same as one that works
(spec section 2, rule 20).

---

## Architecture: why the shell is so thin

```
src/extension/          pure, ESM, covered by `npm run verify`
  types.ts              view models
  presenter.ts          decision -> status bar, indicators, explanation, history
  settings.ts           editor settings -> validated overrides
  chat.ts               `@routepilot` replies

extension/              the VS Code shell, CommonJS, its own package
  src/core.ts           the CommonJS -> ESM bridge
  src/extension.ts      activate, commands, widgets — wiring only
```

The extension host cannot be driven from RoutePilot's test runner, so anything
implemented in the shell ships unverified. Keeping the shell to wiring makes the
unverified surface small enough to describe in the list above, instead of being
"the extension".

### The CommonJS/ESM boundary

The core is ESM; the extension host loads extensions as CommonJS. A CommonJS
module cannot `require()` an ESM one, so `core.ts` bridges with a dynamic
`import()` — preserved rather than downlevelled because the extension compiles
under `module: Node16`.

Two things about that bridge were only discovered by testing the packaged
artifact rather than the repository:

1. **The core must be copied into the extension.** A `.vsix` is self-contained,
   so `extension/dist/` is the extension's own copy, written by
   `scripts/sync-extension-core.mjs`. Importing `../../dist` worked in the
   repository and would have failed for every user.
2. **That copy needs its own `package.json` marking it ESM.** The extension
   package is `"type": "commonjs"`, and without a nested `{"type":"module"}` the
   core's files are read as CommonJS and every `import` is a syntax error. This
   failed only in the extracted `.vsix`.

---

## Settings narrow; they never widen

A workspace `.vscode/settings.json` arrives with a repository — through a clone,
a branch, or a pull request from a stranger — and VS Code applies it without
ceremony. So editor settings may make RoutePilot **more** careful and never
less:

| Setting                                | Allowed direction                               |
| -------------------------------------- | ----------------------------------------------- |
| `routepilot.requestBudget`             | may lower the configured budget, never raise it |
| `routepilot.minimumSuccessProbability` | may raise the threshold, never lower it         |
| `routepilot.exploration.enabled`       | may switch exploration off, never on            |
| `routepilot.operationMode`             | may become stricter, never laxer                |

Anything refused is reported to the user rather than silently dropped: someone
who set a budget of 50 and got 1 should be told the file did not win.

---

## Commands

| Command                                           | What it does                                       |
| ------------------------------------------------- | -------------------------------------------------- |
| **RoutePilot: Route a task**                      | Asks for a task, routes it, updates the status bar |
| **RoutePilot: Explain the last routing decision** | Opens the full explanation as Markdown             |
| **RoutePilot: Show recent history**               | Lists recorded outcomes                            |
| **RoutePilot: Cancel the running analysis**       | Stops an analysis in flight                        |
| **RoutePilot: Open settings**                     | Opens the settings UI filtered to RoutePilot       |

---

## Building and checking

```bash
npm run build:extension     # sync the core, compile the shell
npm run verify:extension    # build, then run the 19 fake-host checks
npm run package:extension   # build, then produce extension/routepilot.vsix
```

`npm run verify` covers the pure layer (`src/extension/`) as part of the main
suite. The shell is checked separately because it is a different package with a
different module system.

---

## Packaging

A `.vsix` is a self-contained archive. Whatever the extension imports at
runtime has to be inside it, because an installed extension sits in a directory
with no ancestor `node_modules` to borrow from.

Two things follow, and both are enforced rather than remembered:

1. `npm run build:extension` runs `npm install --omit=dev` inside `extension/`,
   so the extension carries its own copy of every runtime dependency.
2. `scripts/verify-package.mjs` resolves each declared dependency the way Node
   will and asserts the resolution lands **inside** `extension/`. It runs as
   part of `verify:extension`, `package:extension` and the quality gate.

The second is the one that matters. Inside the repository a missing dependency
still resolves, because Node walks up and finds the root `node_modules` — so a
broken package works perfectly on the machine that built it. That is precisely
how `zod` came to be declared in `extension/package.json` and never installed
there: every check passed, and the first user to install the `.vsix` would have
seen `Cannot find package 'zod'`.

Checking by _location_ rather than by copying the files somewhere isolated is
deliberate: a temporary directory can itself sit under an ancestor
`node_modules` — this machine has one — and the check would then pass for the
wrong reason.

---

## Verified in a real extension host

`npm run verify:vscode` launches the VS Code already installed on the machine —
not a downloaded build — with `--extensionDevelopmentPath` and
`--extensionTestsPath`, and runs `extension/test/host-suite.cjs` **inside** the
host. Eight checks: the manifest is accepted, activation succeeds, every
contributed command id is registered, the ESM core loads inside the CommonJS
host, a task routes end to end, the telemetry store opens, and `cancel` and
`openSettings` run.

Two things had to be solved before it ran at all, and both are the kind that
report success while doing nothing:

- **Run from a terminal inside VS Code, the child inherits the parent editor.**
  `ELECTRON_RUN_AS_NODE=1` and the `VSCODE_*` variables make `Code.exe` behave
  as a bare Node interpreter, or hand the arguments to the running instance and
  exit 0 immediately. The runner strips every inherited `VSCODE_*` and
  `ELECTRON_*` variable and launches with a private `--user-data-dir`.
- **The host's stdout does not reliably reach the parent process.** Exit code 0
  therefore cannot distinguish "all checks passed" from "the suite never ran" —
  and the first version of this did exactly that, reporting success on a run
  where nothing executed. The suite now writes a JSON report and the runner
  fails if that file is absent.

Running it found a real defect that no fake host could have: the extension's
own error message pointed at `extension/config/routepilot.example.json`, a file
that was never packaged. It ships now, so the extension falls back to the
bundled example exactly as the CLI does.

---

## Known limitations

1. **Nobody has run it in VS Code.** See above.
2. **History is almost always empty.** Nothing in RoutePilot executes tasks yet,
   so there are no outcomes to record. The history command says so rather than
   showing an empty list.
3. **The chat participant does not use the language model API.** It answers from
   the router's own output. It cannot discuss code, and says so.
4. **`routepilot.configPath` is not watched.** Changing configuration requires
   re-running a command; the extension does not reload on file change.
5. **Analysis is not cached across commands.** Routing the same task twice
   re-analyses the repository. The core's analysis cache is per-process and the
   extension holds one process, so this is cheaper than it sounds, but it is not
   free.
