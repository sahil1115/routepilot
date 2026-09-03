/**
 * What the editor shows.
 *
 * The VS Code extension host cannot be driven from this suite, so the logic was
 * deliberately kept out of it — and that is only worth doing if the logic is
 * then actually tested. These are those tests.
 *
 * The most important section is the last one: **no secrets in the UI**. Every
 * string here can reach a tooltip, a panel, a notification or an output
 * channel, and a leak in any of them is the same leak.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../core/registry/model-registry.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import type { RoutingDecision } from '../core/types/routing.js';
import type { OutcomeRecord } from '../core/types/telemetry.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';
import { REDACTED } from '../telemetry/redaction.js';
import { COMMANDS, explanationMarkdown, historyRows, present, shortName } from './presenter.js';

const LADDER = [cheapModel(), mediumModel(), frontierModel()];

function decide(
  overrides: Parameters<typeof policy>[0] = {},
  task = 'add a helper function',
): RoutingDecision {
  return new RoutingEngine(new ModelRegistry(LADDER)).route({
    features: featuresFor(task),
    policy: policy({ minimumSuccessProbability: 0.5, ...overrides }),
  });
}

const routed = (decision = decide()) =>
  present({ kind: 'routed', decision, task: 'add a helper function' });

// ---------------------------------------------------------------------------
// Status bar and indicators
// ---------------------------------------------------------------------------

describe('the status bar', () => {
  it('shows the model and the expected cost, not the provider prefix', () => {
    // A status bar entry has a few dozen pixels. "acme/fast-1" spends half of
    // them on a prefix that is the same for every candidate.
    const view = routed();

    expect(view.statusBar.text).toContain('fast-1');
    expect(view.statusBar.text).not.toContain('acme/');
    expect(view.statusBar.text).toMatch(/\d\.\d{4} USD/);
  });

  it('is clickable through to the explanation', () => {
    expect(routed().statusBar.command).toBe(COMMANDS.explain);
  });

  it('spins and offers cancellation while analysing', () => {
    const view = present({ kind: 'analysing', task: 'refactor the parser' });

    expect(view.statusBar.busy).toBe(true);
    expect(view.statusBar.text).toContain('sync~spin');
    expect(view.statusBar.command).toBe(COMMANDS.cancel);
    expect(view.statusBar.tooltip).toContain('cancel');
  });

  it('reports a router failure as an error, cleanly', () => {
    const view = present({ kind: 'failed', message: 'configuration file is not valid JSON' });

    expect(view.statusBar.severity).toBe('error');
    expect(view.statusBar.text).toContain('$(error)');
    expect(view.statusBar.tooltip).toContain('not valid JSON');
    // Still clickable: a dead status bar entry gives the user nowhere to go.
    expect(view.statusBar.command).toBe(COMMANDS.route);
  });

  it('says so plainly when no model could be selected', () => {
    const view = routed(decide({ requestBudget: 0.0000001, onBudgetExceeded: 'stop' }));

    expect(view.model).toBeNull();
    expect(view.statusBar.severity).toBe('warning');
    expect(view.statusBar.text).toContain('no model');
  });

  it('warns rather than sitting neutral when over budget', () => {
    const view = routed(decide({ requestBudget: 0.0001, onBudgetExceeded: 'allow-fallback' }));

    expect(view.cost?.overBudget).toBe(true);
    expect(view.statusBar.severity).toBe('warning');
  });

  it('starts idle and ready', () => {
    const view = present({ kind: 'idle' });

    expect(view.phase).toBe('idle');
    expect(view.statusBar.busy).toBe(false);
    expect(view.statusBar.command).toBe(COMMANDS.route);
  });

  it('reports a cancelled request without dressing it as a failure', () => {
    const view = present({ kind: 'cancelled', task: 'refactor the parser' });

    expect(view.statusBar.severity).toBe('neutral');
    expect(view.statusBar.text).toContain('cancelled');
  });
});

describe('the model indicator', () => {
  it('carries the estimate and the evidence behind it', () => {
    const view = routed();

    expect(view.model?.modelId).toBe('acme/fast-1');
    expect(view.model?.shortName).toBe('fast-1');
    expect(view.model?.successProbability).toBeGreaterThan(0);
    // Zero observations is a normal, honest answer, not a missing value.
    expect(view.model?.observations).toBe(0);
    expect(view.model?.learned).toBe(false);
  });

  it('distinguishes a learned estimate from a configured prior in the tooltip', () => {
    expect(routed().statusBar.tooltip).toContain('configured prior');
  });
});

describe('the cost indicator', () => {
  it('reports the first attempt and the expected total separately', () => {
    const view = routed();

    expect(view.cost?.initial).toBeGreaterThan(0);
    expect(view.cost?.expectedTotal).toBeGreaterThanOrEqual(view.cost?.initial ?? 0);
  });

  it('reports the budget fraction as null when there is no budget', () => {
    // Zero would render as a full bar sitting empty, which reads as a limit
    // that exists.
    expect(routed(decide({ requestBudget: undefined })).cost?.budgetFraction).toBeNull();
  });

  it('reports the budget fraction when there is one', () => {
    const view = routed(decide({ requestBudget: 1 }));

    expect(view.cost?.budgetFraction).toBeGreaterThan(0);
    expect(view.statusBar.tooltip).toContain('Budget used');
  });

  it('calls every figure an estimate', () => {
    expect(routed().statusBar.tooltip).toContain('not measurements');
  });
});

describe('the escalation indicator', () => {
  it('names the model a failure would escalate to', () => {
    const view = routed();

    expect(view.escalation?.targetModelId).not.toBeNull();
    expect(view.escalation?.estimatedCost).toBeGreaterThan(0);
  });

  it('reports null cost when there is nothing stronger to escalate to', () => {
    // Zero would read as "escalation is free".
    const strongest = routed(decide({}, 'add a helper function'));
    const frontier = strongest.escalation;

    expect(frontier).not.toBeNull();
    const noTarget = present({
      kind: 'routed',
      task: 't',
      decision: new RoutingEngine(new ModelRegistry([frontierModel()])).route({
        features: featuresFor('add a helper function'),
        policy: policy({ minimumSuccessProbability: 0.5 }),
      }),
    });

    expect(noTarget.escalation?.targetModelId).toBeNull();
    expect(noTarget.escalation?.estimatedCost).toBeNull();
    expect(noTarget.escalation?.likely).toBe(false);
  });

  it('flags escalation in the status bar only when it is likely', () => {
    // A rename leaves a 12% chance of failure — not worth interrupting anyone
    // over.
    const unlikely = routed(decide({}, 'rename a variable'));
    expect(unlikely.escalation?.failureProbability).toBeLessThan(0.25);
    expect(unlikely.escalation?.likely).toBe(false);
    expect(unlikely.statusBar.text).not.toContain('arrow-up');

    // Adding a helper leaves 27%, which changes how a user feels about
    // starting, so it is surfaced.
    const likely = routed(decide({}, 'add a helper function'));
    expect(likely.escalation?.failureProbability).toBeGreaterThan(0.25);
    expect(likely.escalation?.likely).toBe(true);
    expect(likely.statusBar.text).toContain('arrow-up');
  });
});

// ---------------------------------------------------------------------------
// The explanation
// ---------------------------------------------------------------------------

describe('the routing explanation', () => {
  it('reuses the core’s own explanation lines rather than re-deriving them', () => {
    // The editor and the CLI must never disagree about why a model was chosen.
    const decision = decide();
    const markdown = explanationMarkdown(decision);

    for (const line of decision.explanation) {
      expect(markdown).toContain(line);
    }
  });

  it('lists every candidate with its scores', () => {
    const markdown = explanationMarkdown(decide());

    expect(markdown).toContain('## Candidates');
    for (const id of ['acme/fast-1', 'acme/balanced-1', 'acme/deep-1']) {
      expect(markdown).toContain(id);
    }
  });

  it('marks the selected model', () => {
    expect(explanationMarkdown(decide())).toContain('**selected**');
  });

  it('says nothing was executed', () => {
    expect(explanationMarkdown(decide())).toContain('nothing has been executed');
  });

  it('explains an empty candidate list rather than showing an empty table', () => {
    // Every fixture model has every capability, so the honest way to empty the
    // list is to exclude them outright rather than to invent a capability none
    // of them has.
    const decision = new RoutingEngine(new ModelRegistry(LADDER)).route({
      features: featuresFor('add a helper function'),
      policy: policy(),
      excludeModelIds: LADDER.map((model) => model.id),
    });

    expect(decision.evaluations).toHaveLength(0);
    expect(explanationMarkdown(decision)).toContain('No model satisfied');
  });
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

describe('the history view', () => {
  const outcome = (overrides: Partial<OutcomeRecord> = {}): OutcomeRecord => ({
    requestId: 'req-1',
    syntaxValid: null,
    lintPassed: null,
    buildPassed: true,
    testsPassed: true,
    taskCriteriaMet: null,
    userAccepted: null,
    userCancelled: false,
    userRePrompted: false,
    userReverted: false,
    manualEditRequired: false,
    escalationCount: 0,
    modelsUsed: ['acme/fast-1'],
    totalCost: 0.02,
    currency: 'USD',
    totalLatencyMs: 4_000,
    failureType: null,
    successScore: 0.95,
    evidence: 0.6,
    modelAttributable: true,
    recordedAt: 1_700_000_000_000,
    ...overrides,
  });

  it('renders a recorded outcome', () => {
    const [row] = historyRows([outcome()]);

    expect(row?.modelsUsed).toEqual(['acme/fast-1']);
    expect(row?.cost).toBe(0.02);
    expect(row?.outcome).toBe('succeeded');
  });

  it('reports an unevaluated task as unevaluated, never as failed', () => {
    // A task nobody checked has an unknown result. Calling it a failure in a
    // history panel would misrepresent the model (spec section 31).
    const [row] = historyRows([outcome({ successScore: null })]);

    expect(row?.successScore).toBeNull();
    expect(row?.outcome).toBe('not evaluated');
  });

  it('distinguishes partial success from failure', () => {
    expect(historyRows([outcome({ successScore: 0.6 })])[0]?.outcome).toBe('partial');
    expect(historyRows([outcome({ successScore: 0.1 })])[0]?.outcome).toBe('failed');
  });

  it('reports a cancelled task as cancelled', () => {
    expect(historyRows([outcome({ userCancelled: true })])[0]?.outcome).toBe('cancelled');
  });

  it('carries the escalation count', () => {
    expect(historyRows([outcome({ escalationCount: 2 })])[0]?.escalations).toBe(2);
  });

  it('handles an empty history', () => {
    expect(historyRows([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// No secrets in the UI
// ---------------------------------------------------------------------------

describe('nothing user-facing carries a secret', () => {
  const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL';

  /** Every string a view can put in front of a user. */
  const surfaces = (view: ReturnType<typeof present>): string[] => [
    view.statusBar.text,
    view.statusBar.tooltip,
    view.explanation,
    view.summary,
  ];

  it('redacts a key that reaches a failure message', () => {
    const view = present({
      kind: 'failed',
      message: `provider rejected the request: authorization=${SECRET}`,
    });

    for (const surface of surfaces(view)) {
      expect(surface).not.toContain(SECRET);
    }
    expect(view.statusBar.tooltip).toContain(REDACTED);
  });

  it('redacts a key pasted into a task prompt', () => {
    // A user pasting a failing curl command into the task box is not exotic.
    const view = present({ kind: 'analysing', task: `fix the call using ${SECRET}` });

    for (const surface of surfaces(view)) {
      expect(surface).not.toContain(SECRET);
    }
  });

  it('strips absolute paths, which identify the machine and the user', () => {
    const view = present({
      kind: 'failed',
      message: 'could not read C:\\Users\\someone\\secrets\\routepilot.config.json',
    });

    expect(view.statusBar.tooltip).not.toContain('C:\\Users\\someone');
    // The useful part survives: a stripped message that says nothing is no
    // better than no message.
    expect(view.statusBar.tooltip).toContain('routepilot.config.json');
  });

  it('redacts every surface of a routed view, not only the tooltip', () => {
    const decision = decide();
    const poisoned: RoutingDecision = {
      ...decision,
      reason: `selected because token=${SECRET}`,
      explanation: [`candidate rejected: authorization=${SECRET}`],
    };

    for (const surface of surfaces(routed(poisoned))) {
      expect(surface).not.toContain(SECRET);
    }
  });

  it('redacts an exclusion detail in the explanation', () => {
    const decision = decide();
    const poisoned: RoutingDecision = {
      ...decision,
      excluded: [
        {
          modelId: 'acme/fast-1',
          reason: 'PROVIDER_UNAVAILABLE',
          detail: `auth failed with api_key=${SECRET}`,
        },
      ],
    };

    expect(explanationMarkdown(poisoned)).not.toContain(SECRET);
  });
});

describe('shortName', () => {
  it('drops the provider prefix', () => {
    expect(shortName('acme/fast-1')).toBe('fast-1');
  });

  it('leaves a bare id alone', () => {
    expect(shortName('fast-1')).toBe('fast-1');
  });
});
