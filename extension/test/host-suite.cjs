'use strict';
/**
 * The extension, inside a real VS Code extension host.
 *
 * Everything else that checks this extension runs against `fake-vscode.cjs` — a
 * recorder standing in for the editor. That proves the shell behaves given a
 * `vscode` object; it cannot prove the manifest is accepted, that activation
 * succeeds, that the contributed commands are registered under the ids the
 * manifest claims, or that the ESM core loads inside a CommonJS extension host.
 * Those are exactly the things that only fail in the real host, and until now
 * `docs/EXTENSION.md` said plainly that none of them had ever been tried.
 *
 * This file runs *in* the host. `vscode` is the real module. It is loaded by
 * `scripts/run-vscode-tests.mjs`, which launches the installed VS Code with
 * `--extensionTestsPath` pointed here.
 *
 * It is deliberately read-only: it routes a task and reads what came back. It
 * never executes an agent, so it cannot edit a repository or spend money.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const vscode = require('vscode');

/** Commands the manifest promises. */
const COMMANDS = [
  'routepilot.route',
  'routepilot.explain',
  'routepilot.history',
  'routepilot.cancel',
  'routepilot.openSettings',
];

const results = [];

let detail = null;

async function check(name, fn) {
  detail = null;
  try {
    await fn();
    results.push({ name, ok: true, ...(detail === null ? {} : { detail }) });
    console.log(`  PASS  ${name}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      error: error && error.message ? error.message : String(error),
    });
    console.log(`  FAIL  ${name}`);
    console.log(
      `        ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n        ') : String(error)}`,
    );
  }
}

/** Entry point called by @vscode/test-electron. */
async function run() {
  console.log('\nRoutePilot in a real VS Code extension host\n');
  console.log(`  VS Code ${vscode.version}`);
  console.log(`  Node    ${process.versions.node}\n`);

  const id = process.env.ROUTEPILOT_EXTENSION_ID || 'undefined_publisher.routepilot-vscode';
  let extension;

  await check('the extension is installed and its manifest was accepted', () => {
    extension = vscode.extensions.getExtension(id);
    assert.ok(
      extension,
      `no extension with id "${id}". Installed: ` +
        vscode.extensions.all
          .map((e) => e.id)
          .filter((e) => !e.startsWith('vscode.'))
          .join(', '),
    );
  });

  await check('it activates without throwing', async () => {
    assert.ok(extension, 'not installed');
    await extension.activate();
    assert.equal(extension.isActive, true, 'activate() resolved but isActive is false');
  });

  await check('every command the manifest promises is registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = COMMANDS.filter((command) => !registered.has(command));
    assert.deepEqual(missing, [], `not registered: ${missing.join(', ')}`);
  });

  await check('the ESM core loads inside the CommonJS extension host', async () => {
    // The single most likely thing to fail here and nowhere else. The core is
    // ESM, the host loads extensions as CommonJS, and the bridge is a dynamic
    // import(). If `zod` were missing from the package this is where it shows.
    const core = require(path.join(extension.extensionPath, 'out', 'core.js'));
    const loaded = await core.loadCore();
    assert.ok(loaded.config, 'config module missing');
    assert.ok(loaded.route, 'route module missing');
    assert.equal(typeof loaded.config.loadConfig, 'function', 'loadConfig is not a function');
  });

  await check('routing a task returns a decision, in the real host', async () => {
    // The command opens an input box, which cannot be driven headlessly, so the
    // pipeline is exercised through the core the extension actually loaded --
    // the same modules, in the same process, under the same host.
    const core = require(path.join(extension.extensionPath, 'out', 'core.js'));
    const loaded = await core.loadCore();

    const workspace =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
        ? vscode.workspace.workspaceFolders[0].uri.fsPath
        : process.cwd();

    // `allowBundledExample`, exactly as the CLI does when a workspace has no
    // configuration of its own. Before Phase 26 the example was not packaged,
    // so the extension's own error message pointed at a file that did not
    // exist in the installed extension -- found by this test, in a real host.
    const config = await loaded.config.loadConfig({ cwd: workspace, allowBundledExample: true });
    const routed = await loaded.route.routeTask({
      prompt: 'rename a variable in this file',
      root: workspace,
      level: 1,
      config: config.config,
    });

    assert.ok(routed.decision, 'no decision');
    assert.ok(
      typeof routed.decision.reason === 'string' && routed.decision.reason.length > 0,
      'decision has no reason',
    );
    detail = `model ${routed.decision.selectedModelId || '(none)'} — ${routed.decision.reason.slice(0, 88)}`;
  });

  await check('history opens the telemetry store on this host', async () => {
    // VS Code 1.96+ ships Node 22, so node:sqlite exists here. On an older host
    // this degrades instead of throwing, which is the behaviour Phase 25 added
    // and the reason this assertion is about "no throw" rather than "a store".
    const core = require(path.join(extension.extensionPath, 'out', 'core.js'));
    const loaded = await core.loadCore();
    const store = await loaded.telemetry.openTelemetryStore({ enabled: true });
    assert.equal(typeof store.recentOutcomes, 'function');
    store.close();
  });

  await check('the cancel command is safe to run with nothing in flight', async () => {
    await vscode.commands.executeCommand('routepilot.cancel');
  });

  await check('the settings command runs', async () => {
    await vscode.commands.executeCommand('routepilot.openSettings');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n  ${results.length - failed.length}/${results.length} checks passed\n`);

  // Written to disk, not merely logged. The extension host's stdout does not
  // reliably reach the parent process, so "exit code 0" alone cannot tell
  // "every check passed" from "the suite never ran" -- and a verification step
  // must never confuse those two.
  const report = process.env.ROUTEPILOT_HOST_REPORT;
  if (report) {
    require('node:fs').writeFileSync(
      report,
      JSON.stringify(
        {
          vscode: vscode.version,
          node: process.versions.node,
          extensionPath: extension ? extension.extensionPath : null,
          results,
        },
        null,
        2,
      ),
    );
  }

  if (failed.length > 0) {
    throw new Error(`${failed.length} extension-host check(s) failed`);
  }
}

module.exports = { run };
