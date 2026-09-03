# Development

How work on RoutePilot is done, and what has to be true before a phase is
finished. This is specification section 72, written down and mechanized.

## The loop

Every phase ends the same way:

| #   | step                                     | who does it                                  |
| --- | ---------------------------------------- | -------------------------------------------- |
| 1   | Run tests                                | `npm run phase`                              |
| 2   | Run typecheck                            | `npm run phase`                              |
| 3   | Run lint                                 | `npm run phase`                              |
| 4   | Run build                                | `npm run phase`                              |
| 5   | Inspect the git diff                     | `npm run phase` reports it; a human reads it |
| 6   | Fix all failures                         | a human                                      |
| 7   | Add regression tests for bugs discovered | a human                                      |
| 8   | Update documentation                     | a human                                      |
| 9   | Record what was completed                | a human                                      |
| 10  | Only then proceed                        | `npm run phase` gives the verdict            |

```bash
npm run phase
```

Exit code 0 means proceed, 1 means blocked.

## Why this is not `npm run verify`

`npm run verify` answers "does the code work". It cannot answer "is this phase
finished", and those are different questions. The failure this loop exists to
catch is not a red test — it is a phase that ends green, with an undocumented
change and nothing written down. That is indistinguishable from a finished
phase until someone needs the history six weeks later.

## Steps 6-9 are checked by evidence, never by assertion

A script cannot fix a bug, write a regression test, or decide that
documentation is now accurate. What it can do is refuse to say "proceed" until
the **trace** each step leaves behind exists:

| step                | evidence checked                                                              |
| ------------------- | ----------------------------------------------------------------------------- |
| 6. failures fixed   | steps 1-4 are green                                                           |
| 7. regression tests | `logs.md` has a section for the current phase, and whether it describes a bug |
| 8. documentation    | `docs/ROADMAP.md` has a row for the current phase                             |
| 9. recorded         | that section has all of Objective, Changes Made, Current State, Next Steps    |

Step 7 is the weakest of these and is reported as weak. Nothing distinguishes a
regression test from any other test by inspection, so the script says what it
found and hands the judgement back rather than pretending to have made it.

## Two standing rules

**If a test exposes an architectural problem, stop and fix the architecture.**
Not a narrowing of the assertion, not a special case at the call site. The
Phase 19 example is worked through below, because the tempting workaround was a
one-character change and the correct fix touched nine files.

**If an external dependency is unavailable, do not fake it.** Define the port,
write a mock implementation against it, and document the limitation. RoutePilot
has four such boundaries — `GitPort`, `FileSystemPort`, `DiagnosticsPort`,
`AgentAdapter` — each with a fake used in tests and each with its unverified
status recorded in [INTEGRATIONS.md](INTEGRATIONS.md). No adapter has ever run
against its real tool, and nothing in the codebase claims otherwise.

## Step 5 has a failure mode worth knowing about

`git diff` on an unborn branch — a repository with no commits — exits 0 and
prints nothing. Every file is untracked, so there is genuinely nothing to diff.
An automated loop that shells out to `git diff` and checks the exit code will
report step 5 green while inspecting a void, and will keep doing so for as long
as the branch stays unborn.

This is not hypothetical: it was true of this repository for eighteen phases,
and `npm run phase` was what surfaced it. The script now fails the step
explicitly and says why. It does **not** fix it by committing — principle 13
forbids RoutePilot from committing user code, and that applies to its own
tooling. Creating the baseline commit is a human action:

```bash
git add -A && git commit -m "baseline"
```

## Source hygiene

`src/source-hygiene.test.ts` fails the build on any C0 control character or DEL
in a source file. Tab, newline and carriage return are exempt.

This exists because a NUL byte was written into a string literal in
`fingerprint.ts`, where an escape was resolved one layer too early by the
tooling that wrote the file. TypeScript compiled it, ESLint passed it, Prettier
reformatted around it, and the only signal was `grep` calling the file binary.
On its first run the new guard found a second, pre-existing instance —
raw ANSI escapes in `scripts/quality-gate.mjs`.

An invisible character is not a style question. It survives review because it
cannot be seen in any editor or diff, and it changes behaviour if it lands
inside a literal.

## MVP scope (section 73)

The MVP is the spine and nothing else:

```
TASK -> ROUTING -> MODEL -> EXECUTION -> MONITORING -> ESCALATION -> OUTCOME
```

Eight things are explicitly **not** part of it: complex ML, contextual bandits,
multi-model ensembles, cloud analytics, distributed infrastructure, team
dashboards, complicated AST indexing, and a full dependency graph for every
repository.

Four of those were built anyway, in phases 10-13, before the instruction was
given. They cannot be un-built, so the standard they are held to instead is
that **the spine must work with every one of them switched off** —
`src/e2e/mvp-spine.test.ts` proves it, and would fail if any of them became
load-bearing. The other four have never existed and the same file checks the
tree for them.

| excluded                   | status                                                             |
| -------------------------- | ------------------------------------------------------------------ |
| complex ML                 | not present. Learning is Beta-Bernoulli shrinkage, off by default  |
| contextual bandits         | present since Phase 13, off by default, exploration off by default |
| multi-model ensembles      | never present. Models run one at a time; escalation is sequential  |
| cloud analytics            | never present. No network call anywhere in `src/core`              |
| distributed infrastructure | never present. One process, local SQLite                           |
| team dashboards            | never present                                                      |
| complicated AST indexing   | never present. Analysis is textual                                 |
| full dependency graph      | never present. Analysis is progressive, levels 1-3                 |

The runtime dependency tree is one package (`zod`), which is checked rather than
asserted — infrastructure arrives as dependencies, not as decisions.

## Limitations

1. **Steps 6-9 are checked by proxy.** A phase entry with every required
   heading and nothing true under them passes step 9. The check is that the
   record exists, not that it is honest.
2. **Step 7 cannot verify a regression test exists.** It reports what the log
   says and defers.
3. **Step 5 requires a human to actually read the diff.** The script reports the
   diffstat; nothing confirms anyone looked.
4. **The loop is per-phase, not per-commit.** There is no pre-commit hook, and
   with an unborn branch there is nothing for one to hook onto.
5. **`npm run phase` runs the full suite every time**, which takes around 30
   seconds. It is not meant for the inner development loop; `npm run test:watch`
   is.
