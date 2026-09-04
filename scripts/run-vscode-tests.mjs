#!/usr/bin/env node
/**
 * Run the extension inside a real VS Code extension host.
 *
 * `npm run verify:extension` drives the extension against `fake-vscode.cjs`,
 * which proves the shell behaves given a `vscode` object. It cannot prove the
 * manifest is accepted, that activation succeeds, that the contributed command
 * ids are the ones registered, or that an ESM core loads inside a CommonJS
 * extension host -- each of which fails only in the real thing.
 *
 * This launches the VS Code already installed on this machine, with
 * `--extensionDevelopmentPath` pointed at `extension/` and
 * `--extensionTestsPath` at `extension/test/host-suite.cjs`.
 *
 * Run with `npm run verify:vscode`. Exit code 0 means the extension works in a
 * real host at the VS Code version printed in the output.
 *
 * It opens a VS Code window -- an extension host is an editor -- and closes it
 * when the suite finishes.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const extension = join(root, 'extension');
const reportPath = join(tmpdir(), `routepilot-host-${String(process.pid)}.json`);
const sandboxRoot = join(tmpdir(), `routepilot-vscode-${String(process.pid)}`);
const userDataDir = join(sandboxRoot, 'user-data');
const extensionsDir = join(sandboxRoot, 'extensions');

/**
 * Where VS Code is installed, in the usual places for each platform.
 *
 * Reusing the installed editor rather than downloading one is deliberate: a
 * downloaded build proves the extension works in *a* VS Code, and the question
 * here is whether it works in the one the user actually has.
 */
function installedVSCode() {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const candidates =
    process.platform === 'win32'
      ? [
          join(home, 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'Code.exe'),
          join('C:', 'Program Files', 'Microsoft VS Code', 'Code.exe'),
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code', '/usr/bin/code', '/snap/bin/code'];

  return candidates.find((path) => existsSync(path));
}

// Resolved from `extension/`, where it is a devDependency. This script lives at
// the repository root, so a bare import would look in the root node_modules and
// find nothing.
const requireFromExtension = createRequire(join(extension, 'package.json'));
let runTests;
try {
  ({ runTests } = requireFromExtension('@vscode/test-electron'));
} catch (error) {
  process.stderr.write(`The VS Code test harness is not installed: ${String(error)}\n`);
  process.stderr.write('Run: npm --prefix extension install\n');
  process.exit(2);
}

const executable = installedVSCode();
if (executable === undefined) {
  process.stderr.write('No installed VS Code found, so there is nothing to test against.\n');
  process.stderr.write('Install VS Code, or run this on a machine that has it.\n');
  process.exit(2);
}

process.stdout.write(`Using the installed VS Code at:\n  ${executable}\n`);
rmSync(reportPath, { force: true });

// Strip the parent editor out of the environment before launching a new one.
//
// This matters when the command is run from a terminal *inside* VS Code, which
// is the normal case for this repository. Such a terminal inherits
// ELECTRON_RUN_AS_NODE=1 and a set of VSCODE_* variables including a live IPC
// pipe. The child then behaves as a bare Node interpreter -- "Code.exe: bad
// option: --extensionDevelopmentPath" -- or attaches to the running instance
// and exits 0 immediately, having run nothing at all.
//
// Both failures look like success from the outside, which is why this is code
// rather than a documented caveat.
const inherited = Object.keys(process.env).filter(
  (name) => name.startsWith('VSCODE_') || name.startsWith('ELECTRON_'),
);
for (const name of inherited) delete process.env[name];
if (inherited.length > 0) {
  process.stdout.write(
    '  (cleared ' + String(inherited.length) + ' inherited VS Code variable(s))',
  );
}

let code = 1;
try {
  code = await runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: extension,
    extensionTestsPath: join(extension, 'test', 'host-suite.cjs'),
    // The repository itself is the workspace, so the router has something real
    // to analyse. Other extensions are disabled so nothing else can affect the
    // result.
    launchArgs: [
      root,
      // A private profile, and the reason for it: on Windows, launching the
      // installed Code.exe while a window is already open hands the arguments
      // to that instance and returns immediately -- exit code 0, no tests run.
      // Separate user-data and extensions directories force a genuinely new
      // instance, and keep this run from touching the editor the user has open.
      '--user-data-dir',
      userDataDir,
      '--extensions-dir',
      extensionsDir,
      '--disable-extensions',
      '--disable-gpu',
      '--disable-workspace-trust',
      '--skip-welcome',
      '--skip-release-notes',
      '--no-sandbox',
    ],
    extensionTestsEnv: {
      ROUTEPILOT_EXTENSION_ID: 'undefined_publisher.routepilot-vscode',
      ROUTEPILOT_HOST_REPORT: reportPath,
    },
  });
} catch (error) {
  process.stderr.write(`\nThe extension host run failed: ${String(error)}\n`);
}

// The decisive step. A host that never started also exits 0, and the suite's
// own stdout does not reliably reach this process — so the report file is what
// separates "every check passed" from "nothing ran". Without it, this script
// would be exactly the kind of check that passes for the wrong reason.
if (!existsSync(reportPath)) {
  process.stderr.write('\nThe extension host wrote no report, so nothing was verified.\n');
  process.exit(1);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
rmSync(reportPath, { force: true });
rmSync(sandboxRoot, { recursive: true, force: true, maxRetries: 10 });

process.stdout.write(`\nVS Code ${report.vscode} (Node ${report.node})\n`);
process.stdout.write(`Extension: ${report.extensionPath ?? '(not resolved)'}\n\n`);

for (const result of report.results) {
  process.stdout.write(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name}\n`);
  if (result.detail) process.stdout.write(`        ${result.detail}\n`);
  if (!result.ok) process.stdout.write(`        ${result.error}\n`);
}

const passed = report.results.filter((result) => result.ok).length;
process.stdout.write(`\n  ${passed}/${report.results.length} checks passed in a real host\n\n`);

process.exit(passed === report.results.length && code === 0 ? 0 : 1);
