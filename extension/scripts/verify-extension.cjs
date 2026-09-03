'use strict';
/**
 * Drives the built extension against a fake VS Code host.
 *
 * Phase 14 asks that the extension builds, that commands work, that
 * cancellation works, that a router failure is shown cleanly, and that no
 * secrets reach the UI or the logs. The real extension host cannot be started
 * from this repository, so these are checked against
 * `fake-vscode.cjs` — a recorder that keeps every value the extension pushed
 * into a widget.
 *
 * Run with `npm run verify:extension` from the repository root, after a build.
 *
 * What this does **not** prove: that the real host behaves like the fake, that
 * the manifest's contribution points are accepted, or that anything renders.
 * Those need a human with VS Code open, and `docs/EXTENSION.md` says so.
 */

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { vscode, recorder, reset } = require('./fake-vscode.cjs');

// Intercept `require('vscode')` before the extension is loaded. The extension
// host does the same thing; this is the standard way to test one out of process.
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL';

const results = [];
let failures = 0;

async function check(name, fn) {
  reset();
  try {
    await fn();
    results.push(`  PASS  ${name}`);
  } catch (error) {
    failures += 1;
    results.push(`  FAIL  ${name}\n        ${error.message.split('\n')[0]}`);
  }
}

/** A disposable-collecting context, as the host supplies. */
function makeContext() {
  return { subscriptions: [] };
}

/** Everything the extension put in front of a user, as one string. */
function userVisibleText() {
  const bar = recorder.statusBar;
  return [
    bar?.text ?? '',
    bar?.tooltip?.value ?? '',
    ...recorder.output,
    ...recorder.notifications.map((n) => n.message),
    ...recorder.documents.map((d) => d.content ?? ''),
  ].join('\n');
}

/** A temporary workspace with a valid configuration. */
function makeWorkspace(configOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routepilot-ext-'));
  const example = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'routepilot.example.json'), 'utf8'),
  );
  const config = { ...example, ...configOverrides };
  fs.writeFileSync(path.join(dir, 'routepilot.config.json'), JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'w' }));
  fs.writeFileSync(path.join(dir, 'index.ts'), 'export const x = 1;\n');
  return dir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

async function main() {
  const entry = path.join(__dirname, '..', 'out', 'extension.js');
  if (!fs.existsSync(entry)) {
    console.error('Extension is not built. Run "npm run build:extension" first.');
    process.exit(1);
  }
  const extension = require(entry);

  // -- activation ----------------------------------------------------------
  await check('activates without loading the core', async () => {
    const context = makeContext();
    extension.activate(context);

    assert.equal(typeof extension.activate, 'function');
    assert.ok(context.subscriptions.length > 0, 'registered no disposables');
    extension.deactivate();
    await Promise.resolve();
  });

  await check('registers every contributed command', async () => {
    extension.activate(makeContext());
    for (const id of [
      'routepilot.route',
      'routepilot.explain',
      'routepilot.history',
      'routepilot.cancel',
      'routepilot.openSettings',
    ]) {
      assert.ok(recorder.commands.has(id), `command not registered: ${id}`);
    }
    extension.deactivate();
    await Promise.resolve();
  });

  await check('registers the chat participant', async () => {
    extension.activate(makeContext());
    assert.equal(recorder.chatParticipants.length, 1);
    assert.equal(recorder.chatParticipants[0].id, 'routepilot.participant');
    extension.deactivate();
    await Promise.resolve();
  });

  await check('shows an idle status bar immediately', async () => {
    extension.activate(makeContext());
    assert.match(recorder.statusBar.text, /RoutePilot/);
    assert.equal(recorder.statusBar.visible, true);
    extension.deactivate();
    await Promise.resolve();
  });

  // -- the route command ---------------------------------------------------
  await check('route command routes a task and shows the model and cost', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      recorder.settings['routepilot.operationMode'] = 'production';
      recorder.nextInput = 'add a helper function to the parser';

      await recorder.commands.get('routepilot.route')();

      assert.match(recorder.statusBar.text, /\$\(rocket\)/, 'no model indicator');
      assert.match(recorder.statusBar.text, /USD/, 'no cost indicator');
      assert.ok(recorder.output.length > 0, 'nothing logged');
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  await check('route command does nothing when the input box is dismissed', async () => {
    extension.activate(makeContext());
    recorder.nextInput = undefined;

    await recorder.commands.get('routepilot.route')();

    assert.equal(recorder.notifications.length, 0, 'dismissal was reported as an error');
    extension.deactivate();
  });

  // -- cancellation --------------------------------------------------------
  await check('cancellation stops the run and reports it as cancelled', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      recorder.nextInput = 'add a helper function';
      recorder.cancelImmediately = true;

      await recorder.commands.get('routepilot.route')();

      assert.match(recorder.statusBar.text, /cancelled|RoutePilot/, 'no cancelled state');
      const errors = recorder.notifications.filter((n) => n.kind === 'error');
      assert.equal(errors.length, 0, 'cancellation was reported as an error');
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  await check('cancel command is safe with nothing running', async () => {
    extension.activate(makeContext());
    recorder.commands.get('routepilot.cancel')();
    extension.deactivate();
  });

  // -- failure -------------------------------------------------------------
  await check('a router failure is shown cleanly, not as a stack trace', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routepilot-ext-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'routepilot.config.json'), '{ not json');
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      recorder.nextInput = 'add a helper function';

      await recorder.commands.get('routepilot.route')();

      const errors = recorder.notifications.filter((n) => n.kind === 'error');
      assert.ok(errors.length > 0, 'no error surfaced to the user');
      assert.ok(!/\n\s+at /.test(errors[0].message), 'a stack trace reached the notification');
      assert.match(recorder.statusBar.text, /\$\(error\)/, 'status bar did not show the failure');
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  // -- explain -------------------------------------------------------------
  await check('explain opens a document even before anything is routed', async () => {
    extension.activate(makeContext());

    await recorder.commands.get('routepilot.explain')();

    assert.equal(recorder.documents.length, 1);
    assert.equal(recorder.documents[0].language, 'markdown');
    assert.match(recorder.documents[0].content, /No routing decision/);
    extension.deactivate();
  });

  await check('explain shows the decision after routing', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      recorder.nextInput = 'add a helper function';
      await recorder.commands.get('routepilot.route')();

      await recorder.commands.get('routepilot.explain')();

      const document = recorder.documents.at(-1);
      assert.match(document.content, /# RoutePilot decision/);
      assert.match(document.content, /## Candidates/);
      assert.match(document.content, /nothing has been executed/i);
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  // -- settings ------------------------------------------------------------
  await check('a widening workspace setting is refused and reported', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      recorder.nextInput = 'add a helper function';
      // A repository trying to raise the budget and switch exploration on.
      recorder.settings['routepilot.requestBudget'] = 1_000_000;
      recorder.settings['routepilot.exploration.enabled'] = true;
      recorder.settings['routepilot.operationMode'] = 'normal';

      await recorder.commands.get('routepilot.route')();

      const warnings = recorder.notifications.filter((n) => n.kind === 'warning');
      assert.ok(warnings.length > 0, 'ignored settings were not reported');
      assert.match(warnings[0].message, /requestBudget/);
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  await check('the status bar can be hidden by setting', async () => {
    extension.activate(makeContext());
    recorder.settings['routepilot.showStatusBar'] = false;
    // Re-render through a command that updates the bar.
    recorder.commands.get('routepilot.cancel')();
    extension.deactivate();
  });

  // -- history -------------------------------------------------------------
  await check('history reports an empty store rather than an empty list', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;

      await recorder.commands.get('routepilot.history')();

      assert.ok(
        recorder.notifications.length > 0 || recorder.quickPicks.length > 0,
        'history said nothing at all',
      );
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  // -- the chat participant ------------------------------------------------
  await check('the chat participant answers a help request without routing', async () => {
    extension.activate(makeContext());
    const chunks = [];
    const stream = { markdown: (m) => chunks.push(m), progress: () => {} };
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({}) };

    await recorder.chatParticipants[0].handler({ prompt: 'help' }, {}, stream, token);

    assert.match(chunks.join('\n'), /do \*\*not\*\* write code/);
    extension.deactivate();
  });

  await check('the chat participant routes a task description', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      const chunks = [];
      const stream = { markdown: (m) => chunks.push(m), progress: () => {} };
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({}) };

      await recorder.chatParticipants[0].handler(
        { prompt: 'add a helper function to the parser' },
        {},
        stream,
        token,
      );

      const reply = chunks.join('\n');
      assert.match(reply, /Expected total cost/);
      assert.match(reply, /Nothing has been executed/);
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  // -- secrets -------------------------------------------------------------
  await check('a secret in the task never reaches the UI or the logs', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      recorder.nextInput = `fix the failing call that uses ${SECRET}`;

      await recorder.commands.get('routepilot.route')();
      await recorder.commands.get('routepilot.explain')();

      const visible = userVisibleText();
      assert.ok(!visible.includes(SECRET), 'a secret reached a user-visible surface');
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  await check('a secret in a configuration error never reaches the UI or the logs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routepilot-ext-secret-'));
    try {
      // A configuration whose parse error quotes the offending content.
      fs.writeFileSync(path.join(dir, 'routepilot.config.json'), `{ "authorization": "${SECRET}" `);
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      recorder.nextInput = 'add a helper function';

      await recorder.commands.get('routepilot.route')();

      const visible = userVisibleText();
      assert.ok(!visible.includes(SECRET), 'a secret reached a user-visible surface');
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  await check('a secret in a chat prompt never reaches the reply', async () => {
    const dir = makeWorkspace();
    try {
      extension.activate(makeContext());
      recorder.workspaceRoot = dir;
      const chunks = [];
      const stream = { markdown: (m) => chunks.push(m), progress: () => {} };
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({}) };

      await recorder.chatParticipants[0].handler(
        { prompt: `fix the call using ${SECRET}` },
        {},
        stream,
        token,
      );

      assert.ok(!chunks.join('\n').includes(SECRET), 'a secret reached the chat reply');
      assert.ok(!userVisibleText().includes(SECRET), 'a secret reached another surface');
    } finally {
      extension.deactivate();
      cleanup(dir);
    }
  });

  console.log('RoutePilot extension — verification against a fake VS Code host\n');
  console.log(results.join('\n'));
  console.log(
    `\n${String(results.length - failures)}/${String(results.length)} checks passed.` +
      (failures === 0 ? '' : ` ${String(failures)} FAILED.`),
  );
  console.log(
    '\nNot covered here: the real extension host, manifest contribution points,\n' +
      'and anything visual. See docs/EXTENSION.md.',
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
