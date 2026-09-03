'use strict';
/**
 * A fake `vscode` module.
 *
 * The real extension host cannot be started from this repository's test runner,
 * so the shell would otherwise ship entirely unverified. This implements the
 * slice of the API `extension.ts` actually touches and records everything the
 * extension does, which turns several of Phase 14's validation items from
 * "cannot check" into "checked".
 *
 * It is deliberately **not** a mock framework. It is a recorder: every widget
 * keeps its last value and every call is appended to a log, so a test can
 * assert on what a user would have seen rather than on which functions were
 * called.
 *
 * What this cannot prove is that the real host behaves the same way. That gap
 * is stated in `docs/EXTENSION.md` rather than papered over.
 */

/** Everything the extension did, for assertions. */
const recorder = {
  commands: new Map(),
  statusBar: null,
  output: [],
  notifications: [],
  inputBoxes: [],
  quickPicks: [],
  documents: [],
  chatParticipants: [],
  executedCommands: [],
  /** Scripted answer for the next `showInputBox`. */
  nextInput: undefined,
  /** Scripted answer for the next `showErrorMessage` choice. */
  nextErrorChoice: undefined,
  /** Settings the extension will read. */
  settings: {},
  /** Workspace folder path, or undefined. */
  workspaceRoot: undefined,
  /** When true, every progress task is cancelled immediately. */
  cancelImmediately: false,
};

function reset() {
  recorder.commands = new Map();
  recorder.statusBar = null;
  recorder.output = [];
  recorder.notifications = [];
  recorder.inputBoxes = [];
  recorder.quickPicks = [];
  recorder.documents = [];
  recorder.chatParticipants = [];
  recorder.executedCommands = [];
  recorder.nextInput = undefined;
  recorder.nextErrorChoice = undefined;
  recorder.settings = {};
  recorder.workspaceRoot = undefined;
  recorder.cancelImmediately = false;
}

class Disposable {
  constructor(fn) {
    this.dispose = fn ?? (() => {});
  }
}

class EventEmitterish {
  constructor() {
    this.listeners = [];
  }
  event = (listener) => {
    this.listeners.push(listener);
    return new Disposable(() => {});
  };
  fire() {
    for (const listener of this.listeners) listener();
  }
}

class CancellationTokenSource {
  constructor() {
    this.emitter = new EventEmitterish();
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this.emitter.event,
    };
  }
  cancel() {
    this.token.isCancellationRequested = true;
    this.emitter.fire();
  }
  dispose() {}
}

class MarkdownString {
  constructor(value) {
    this.value = value ?? '';
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class ThemeIcon {
  constructor(id) {
    this.id = id;
  }
}

const vscode = {
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  CancellationTokenSource,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  Disposable,

  window: {
    createStatusBarItem() {
      const item = {
        text: '',
        tooltip: undefined,
        command: undefined,
        backgroundColor: undefined,
        visible: false,
        show() {
          this.visible = true;
        },
        hide() {
          this.visible = false;
        },
        dispose() {},
      };
      recorder.statusBar = item;
      return item;
    },

    createOutputChannel(name) {
      return {
        name,
        appendLine(line) {
          recorder.output.push(line);
        },
        append(text) {
          recorder.output.push(text);
        },
        show() {},
        dispose() {},
      };
    },

    showInputBox(options) {
      recorder.inputBoxes.push(options);
      return Promise.resolve(recorder.nextInput);
    },

    showInformationMessage(message) {
      recorder.notifications.push({ kind: 'info', message });
      return Promise.resolve(undefined);
    },

    showWarningMessage(message) {
      recorder.notifications.push({ kind: 'warning', message });
      return Promise.resolve(undefined);
    },

    showErrorMessage(message) {
      recorder.notifications.push({ kind: 'error', message });
      return Promise.resolve(recorder.nextErrorChoice);
    },

    showQuickPick(items, options) {
      recorder.quickPicks.push({ items, options });
      return Promise.resolve(undefined);
    },

    showTextDocument(document) {
      return Promise.resolve({ document });
    },

    async withProgress(_options, task) {
      const source = new CancellationTokenSource();
      if (recorder.cancelImmediately) source.cancel();
      return task({ report() {} }, source.token);
    },
  },

  commands: {
    registerCommand(id, handler) {
      recorder.commands.set(id, handler);
      return new Disposable(() => recorder.commands.delete(id));
    },
    executeCommand(id, ...args) {
      recorder.executedCommands.push({ id, args });
      return Promise.resolve(undefined);
    },
  },

  workspace: {
    get workspaceFolders() {
      return recorder.workspaceRoot === undefined
        ? undefined
        : [{ uri: { fsPath: recorder.workspaceRoot }, name: 'workspace', index: 0 }];
    },
    getConfiguration(section) {
      return {
        get(key) {
          return recorder.settings[`${section}.${key}`];
        },
      };
    },
    openTextDocument(options) {
      recorder.documents.push(options);
      return Promise.resolve({ ...options, uri: { fsPath: 'untitled:1' } });
    },
  },

  chat: {
    createChatParticipant(id, handler) {
      const participant = { id, handler, iconPath: undefined, dispose() {} };
      recorder.chatParticipants.push(participant);
      return participant;
    },
  },
};

module.exports = { vscode, recorder, reset };
