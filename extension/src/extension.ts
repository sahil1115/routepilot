/**
 * The VS Code shell (spec section 49).
 *
 * Deliberately thin. Every decision about *what* to show lives in
 * `src/extension/` in the main package, where it is pure and covered by the
 * test suite; this file binds those values to widgets and does nothing else.
 *
 * The reason is not architectural taste. The extension host cannot be driven
 * from RoutePilot's test runner, so anything implemented here ships unverified.
 * Keeping it to wiring makes the untested surface small enough to state plainly
 * (spec section 2, rule 20) — see `docs/EXTENSION.md`.
 *
 * ## Two properties this file is responsible for
 *
 * 1. **The UI never blocks.** Routing runs inside `withProgress` with a
 *    cancellation token that is honoured at every await point. Analysis is
 *    already async throughout the core; what this file must not do is await it
 *    outside a cancellable scope.
 * 2. **Nothing logged or shown carries a secret.** Every string reaching the
 *    output channel or a notification comes from the presenter, which redacts
 *    at construction. This file adds no strings of its own beyond fixed text.
 */

import * as vscode from 'vscode';

import { loadCore, type RoutePilotCore } from './core.js';

/** Command ids, mirroring `COMMANDS` in the pure layer. */
const COMMANDS = {
  route: 'routepilot.route',
  explain: 'routepilot.explain',
  history: 'routepilot.history',
  cancel: 'routepilot.cancel',
  settings: 'routepilot.openSettings',
} as const;

type RoutingView = ReturnType<RoutePilotCore['view']['present']>;
type RoutingDecision = Awaited<ReturnType<RoutePilotCore['route']['routeTask']>>['decision'];
type HistoryRow = ReturnType<RoutePilotCore['view']['historyRows']>[number];
type EditorOverrides = ReturnType<RoutePilotCore['view']['resolveSettings']>;
type Analyzer = InstanceType<RoutePilotCore['analyzer']['RepositoryAnalyzer']>;
type StatusBarView = { readonly statusBar: RoutingView['statusBar'] };

/** Everything the extension holds while active. */
interface Session {
  readonly statusBarItem: vscode.StatusBarItem;
  readonly output: vscode.OutputChannel;
  /** The decision most recently produced, for `explain`. */
  lastDecision: RoutingDecision | undefined;
  /** Cancels the analysis currently in flight, if any. */
  cancel: vscode.CancellationTokenSource | undefined;
  /**
   * One analyzer per workspace, kept for the life of the window.
   *
   * The analysis cache lives inside the analyzer, so a fresh one per request
   * would re-read a repository that has not changed. Benchmarks put a warm
   * analysis at effectively zero filesystem work against a cold one that walks
   * the whole tree, so this is the difference between the extension feeling
   * instant and feeling like the CLI (spec section 69).
   */
  analyzers: Map<string, Analyzer>;
}

let session: Session | undefined;

/**
 * Activate.
 *
 * Kept cheap: nothing is imported from the core and no configuration is read
 * until a command runs. Activation cost is charged to the user's window
 * start-up, and an extension that routes nothing until asked has no business
 * spending it.
 */
export function activate(context: vscode.ExtensionContext): void {
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const output = vscode.window.createOutputChannel('RoutePilot');

  session = {
    statusBarItem,
    output,
    lastDecision: undefined,
    cancel: undefined,
    analyzers: new Map(),
  };

  context.subscriptions.push(statusBarItem, output);
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.route, () => commandRoute()),
    vscode.commands.registerCommand(COMMANDS.explain, () => commandExplain()),
    vscode.commands.registerCommand(COMMANDS.history, () => commandHistory()),
    vscode.commands.registerCommand(COMMANDS.cancel, () => {
      commandCancel();
    }),
    vscode.commands.registerCommand(COMMANDS.settings, () => {
      void vscode.commands.executeCommand('workbench.action.openSettings', 'routepilot');
    }),
  );

  context.subscriptions.push(registerChatParticipant());

  render(idleView());
}

/** Deactivate. Cancels anything in flight so no work outlives the window. */
export function deactivate(): void {
  session?.cancel?.cancel();
  session = undefined;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandRoute(): Promise<void> {
  const active = session;
  if (active === undefined) return;

  const task = await vscode.window.showInputBox({
    title: 'RoutePilot',
    prompt: 'Describe the task. RoutePilot chooses a model; it does not run one.',
    placeHolder: 'add pagination to the users endpoint',
    ignoreFocusOut: true,
  });

  // `undefined` is a dismissed box, which is a cancellation, not an error.
  if (task === undefined || task.trim() === '') return;

  await runRouting(active, task.trim());
}

/**
 * Route one task with progress and cancellation.
 *
 * The token is checked after every await. Cancellation cannot interrupt a
 * synchronous computation, but every expensive step here — configuration
 * loading, repository analysis — is asynchronous, so the gaps are real.
 */
async function runRouting(active: Session, task: string): Promise<void> {
  active.cancel?.cancel();
  const tokenSource = new vscode.CancellationTokenSource();
  active.cancel = tokenSource;

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: 'RoutePilot: routing…',
        cancellable: true,
      },
      async (_progress, progressToken) => {
        progressToken.onCancellationRequested(() => {
          tokenSource.cancel();
        });
        // Subscribing is not enough on its own: a token that was already
        // cancelled before the task started fires no event, and the run would
        // proceed as though nothing had happened.
        if (progressToken.isCancellationRequested) tokenSource.cancel();

        const core = await loadCore();
        if (tokenSource.token.isCancellationRequested) {
          render(present(core, { kind: 'cancelled', task }));
          return;
        }

        render(present(core, { kind: 'analysing', task }));

        const decision = await route(core, task, tokenSource.token);
        // `undefined` means the token fired mid-flight. Cancellation is not a
        // failure, and must not leave a stale decision behind for `explain`.
        if (decision === undefined || tokenSource.token.isCancellationRequested) {
          render(present(core, { kind: 'cancelled', task }));
          return;
        }

        active.lastDecision = decision;
        const view = present(core, { kind: 'routed', decision, task });
        render(view);
        log(active, view.summary);
      },
    );
  } catch (error) {
    await reportFailure(active, error);
  } finally {
    if (active.cancel === tokenSource) active.cancel = undefined;
    tokenSource.dispose();
  }
}

/** Load configuration, resolve settings and route. */
async function route(
  core: RoutePilotCore,
  task: string,
  token: vscode.CancellationToken,
): Promise<RoutingDecision | undefined> {
  const settings = vscode.workspace.getConfiguration('routepilot');
  const explicitPath = settings.get<string>('configPath')?.trim();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const loaded = await core.config.loadConfig({
    ...(explicitPath === undefined || explicitPath === '' ? {} : { explicitPath }),
    ...(root === undefined ? {} : { cwd: root }),
  });
  if (token.isCancellationRequested) return undefined;

  const config = loaded.config as {
    routing: { minimumSuccessProbability: number };
    budgets: { request?: number };
    learning: { exploration: { enabled: boolean } };
  };

  const overrides = core.view.resolveSettings(
    {
      requestBudget: settings.get<number | null>('requestBudget') ?? undefined,
      minimumSuccessProbability:
        settings.get<number | null>('minimumSuccessProbability') ?? undefined,
      explorationEnabled: settings.get<boolean | null>('exploration.enabled') ?? undefined,
      operationMode: settings.get<string>('operationMode'),
      analysisLevel: settings.get<number | null>('analysisLevel') ?? undefined,
      showStatusBar: settings.get<boolean>('showStatusBar'),
    },
    {
      requestBudget: config.budgets.request,
      minimumSuccessProbability: config.routing.minimumSuccessProbability,
      explorationEnabled: config.learning.exploration.enabled,
      operationMode: 'production',
    },
  );

  reportIgnoredSettings(overrides);

  // `level` is required. When the user has not pinned one, the CLI's own
  // chooser decides from the task, so the editor and the terminal analyse a
  // given task to the same depth.
  const level =
    overrides.analysisLevel ??
    core.analyze.chooseAnalysisLevel(
      new core.classifier.TaskClassifier().classify({ prompt: task }),
    );

  const result = await core.route.routeTask({
    prompt: task,
    root: root ?? process.cwd(),
    level,
    analyzer: sharedAnalyzer(core, root ?? process.cwd()),
    config: loaded.config,
    policyOverrides: overrides.policyOverrides,
    operationMode: overrides.operationMode,
  });

  return result.decision;
}

/**
 * Tell the user which of their settings were ignored.
 *
 * Silently dropping a setting leaves someone convinced they lowered a budget
 * when they did not.
 */
function reportIgnoredSettings(overrides: EditorOverrides): void {
  if (overrides.ignored.length === 0) return;

  void vscode.window.showWarningMessage(
    `RoutePilot ignored ${String(overrides.ignored.length)} setting(s): ${overrides.ignored.join('; ')}`,
  );
}

async function commandExplain(): Promise<void> {
  const active = session;
  if (active === undefined) return;

  const core = await loadCore().catch(() => undefined);
  if (core === undefined) return;

  const markdown =
    active.lastDecision === undefined
      ? '# RoutePilot\n\nNo routing decision has been made yet. Run **RoutePilot: Route a task**.'
      : core.view.explanationMarkdown(active.lastDecision);

  // An untitled Markdown document rather than a webview: it is previewable,
  // copyable and savable with no custom UI to maintain or to get wrong.
  const document = await vscode.workspace.openTextDocument({
    content: markdown,
    language: 'markdown',
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function commandHistory(): Promise<void> {
  const active = session;
  if (active === undefined) return;

  try {
    const core = await loadCore();
    const settings = vscode.workspace.getConfiguration('routepilot');
    const explicitPath = settings.get<string>('configPath')?.trim();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    const loaded = await core.config.loadConfig({
      ...(explicitPath === undefined || explicitPath === '' ? {} : { explicitPath }),
      ...(root === undefined ? {} : { cwd: root }),
    });
    const config = loaded.config as {
      telemetry: { enabled: boolean; storagePath?: string };
    };

    if (!config.telemetry.enabled) {
      void vscode.window.showInformationMessage(
        'RoutePilot: telemetry is disabled, so no history has been recorded.',
      );
      return;
    }

    const store = await core.telemetry.openTelemetryStore({
      enabled: true,
      ...(config.telemetry.storagePath === undefined
        ? {}
        : { storagePath: config.telemetry.storagePath }),
      ...(root === undefined ? {} : { workspaceRoot: root }),
    });
    const rows = core.view.historyRows(store.recentOutcomes(50));
    store.close();

    if (rows.length === 0) {
      void vscode.window.showInformationMessage(
        'RoutePilot: no tasks have been recorded yet. Nothing executes tasks in this build.',
      );
      return;
    }

    await showHistory(rows as HistoryRow[]);
  } catch (error) {
    await reportFailure(active, error);
  }
}

async function showHistory(rows: readonly HistoryRow[]): Promise<void> {
  const items = rows.map((row) => ({
    label: `${row.outcome} · ${row.modelsUsed.join(' → ')}`,
    description: `${row.cost.toFixed(4)} ${row.currency}`,
    detail:
      `${new Date(row.recordedAt).toLocaleString()}` +
      (row.escalations > 0 ? ` · ${String(row.escalations)} escalation(s)` : ''),
  }));

  await vscode.window.showQuickPick(items, {
    title: 'RoutePilot — recent tasks',
    placeHolder: 'Recorded outcomes, newest first',
  });
}

function commandCancel(): void {
  const active = session;
  if (active?.cancel === undefined) return;

  active.cancel.cancel();
  void vscode.window.showInformationMessage('RoutePilot: analysis cancelled.');
}

// ---------------------------------------------------------------------------
// Chat participant
// ---------------------------------------------------------------------------

/**
 * The `@routepilot` participant.
 *
 * Explains routing. It does not write code, and says so, because a participant
 * that leaves that ambiguous will be asked to and will disappoint.
 */
function registerChatParticipant(): vscode.Disposable {
  const handler: vscode.ChatRequestHandler = async (request, _context, stream, token) => {
    const active = session;
    if (active === undefined) return;

    try {
      const core = await loadCore();
      const intent = core.view.classifyChatPrompt(request.prompt);

      if (intent === 'help') {
        stream.markdown(core.view.helpReply().markdown);
        return;
      }

      if (intent === 'explain') {
        const reply =
          active.lastDecision === undefined
            ? core.view.nothingToExplainReply()
            : core.view.explainReply(active.lastDecision);
        stream.markdown(reply.markdown);
        return;
      }

      stream.progress('Analysing the workspace…');
      const decision = await route(core, request.prompt, token);
      if (decision === undefined || token.isCancellationRequested) return;

      active.lastDecision = decision;
      render(present(core, { kind: 'routed', decision, task: request.prompt }));
      stream.markdown(core.view.routeReply(request.prompt, decision).markdown);
    } catch (error) {
      // The message is already redacted by the presenter when it comes from
      // routing; a thrown error is redacted here before it reaches the stream.
      const core = await loadCore().catch(() => undefined);
      const view =
        core === undefined
          ? undefined
          : present(core, { kind: 'failed', message: describe(error) });
      stream.markdown(
        `**RoutePilot could not route this.**\n\n${view?.summary ?? 'See the RoutePilot output channel.'}`,
      );
    }
  };

  const participant = vscode.chat.createChatParticipant('routepilot.participant', handler);
  participant.iconPath = new vscode.ThemeIcon('rocket');
  return participant;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function present(
  core: RoutePilotCore,
  state: Parameters<RoutePilotCore['view']['present']>[0],
): RoutingView {
  return core.view.present(state);
}

/**
 * The idle status bar, built without the core.
 *
 * Activation must not import the core, so this is the one view constructed by
 * hand. It carries no user data, so there is nothing to redact.
 */
function idleView(): StatusBarView {
  return {
    statusBar: {
      text: '$(rocket) RoutePilot',
      tooltip: 'RoutePilot is ready. Click to route a task.',
      command: COMMANDS.route,
      severity: 'neutral',
      busy: false,
    },
  };
}

/** Push a view onto the status bar. */
function render(view: StatusBarView): void {
  const active = session;
  if (active === undefined) return;

  if (vscode.workspace.getConfiguration('routepilot').get<boolean>('showStatusBar') === false) {
    active.statusBarItem.hide();
    return;
  }

  const item = active.statusBarItem;
  item.text = view.statusBar.text;
  item.tooltip = new vscode.MarkdownString(view.statusBar.tooltip);
  item.command = view.statusBar.command ?? undefined;
  item.backgroundColor =
    view.statusBar.severity === 'error'
      ? new vscode.ThemeColor('statusBarItem.errorBackground')
      : view.statusBar.severity === 'warning'
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined;
  item.show();
}

/**
 * Report a router failure cleanly.
 *
 * A stack trace in a notification is not a clean failure. The message goes
 * through the presenter, which redacts it, and the full text lands in the
 * output channel where a user can read it without it blocking the editor.
 */
async function reportFailure(active: Session, error: unknown): Promise<void> {
  const message = describe(error);
  const core = await loadCore().catch(() => undefined);

  if (core === undefined) {
    // The core failed to load, so nothing can be redacted by it. Show only the
    // fixed guidance rather than an unredacted message.
    active.statusBarItem.text = '$(error) RoutePilot';
    active.statusBarItem.show();
    void vscode.window.showErrorMessage('RoutePilot could not start. See the RoutePilot output.');
    active.output.appendLine('RoutePilot could not load its core.');
    return;
  }

  const view = present(core, { kind: 'failed', message });
  render(view);
  log(active, view.summary);

  const choice = await vscode.window.showErrorMessage(
    `RoutePilot: ${view.summary}`,
    'Show details',
    'Open settings',
  );
  if (choice === 'Show details') active.output.show(true);
  if (choice === 'Open settings') {
    void vscode.commands.executeCommand('workbench.action.openSettings', 'routepilot');
  }
}

/**
 * The analyzer for a workspace, created once and kept.
 *
 * Keyed by root so a multi-root window does not share one cache between
 * unrelated repositories — the cache is keyed by root internally too, but two
 * windows' worth of state in one map would grow without bound.
 */
function sharedAnalyzer(core: RoutePilotCore, root: string): Analyzer | undefined {
  const active = session;
  if (active === undefined) return undefined;

  const existing = active.analyzers.get(root);
  if (existing !== undefined) return existing;

  const created = new core.analyzer.RepositoryAnalyzer({
    fs: new core.fs.NodeFileSystem(),
    git: new core.git.NodeGit(),
  });
  active.analyzers.set(root, created);
  return created;
}

/** Append to the output channel. The text is already redacted by the presenter. */
function log(active: Session, text: string): void {
  active.output.appendLine(`[${new Date().toISOString()}] ${text}`);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
