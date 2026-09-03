/**
 * The `@routepilot` chat participant's replies.
 *
 * Two things must hold. The participant must be **clear about what it is not**
 * — it picks a model, it does not write code — because a participant that
 * leaves that ambiguous will be asked to write code and will disappoint. And
 * its replies must carry no secrets, exactly like every other surface.
 */

import { describe, expect, it } from 'vitest';

import { ModelRegistry } from '../core/registry/model-registry.js';
import { RoutingEngine } from '../core/routing/routing-engine.js';
import type { RoutingDecision } from '../core/types/routing.js';
import {
  cheapModel,
  featuresFor,
  frontierModel,
  mediumModel,
  policy,
} from '../test-support/routing-fixtures.js';
import {
  classifyChatPrompt,
  explainReply,
  helpReply,
  nothingToExplainReply,
  routeReply,
} from './chat.js';
import { COMMANDS } from './presenter.js';

const LADDER = [cheapModel(), mediumModel(), frontierModel()];

const decide = (overrides: Parameters<typeof policy>[0] = {}): RoutingDecision =>
  new RoutingEngine(new ModelRegistry(LADDER)).route({
    features: featuresFor('add pagination to the users endpoint'),
    policy: policy({ minimumSuccessProbability: 0.5, ...overrides }),
  });

describe('classifying a prompt', () => {
  it('treats a task description as a routing request', () => {
    expect(classifyChatPrompt('add pagination to the users endpoint')).toBe('route');
  });

  it('treats an explicit ask for reasoning as an explanation request', () => {
    for (const prompt of ['explain', 'why that model?', 'which model would you use']) {
      expect(classifyChatPrompt(prompt)).toBe('explain');
    }
  });

  it('treats a greeting or a bare word as a request for help, not a task', () => {
    // Guessing wrong charges the user for an analysis they did not ask for.
    for (const prompt of ['hi', 'hello there', '', '   ']) {
      expect(classifyChatPrompt(prompt)).toBe('help');
    }
  });

  it('answers an explicit help request', () => {
    for (const prompt of ['help', '/help', 'what can you do']) {
      expect(classifyChatPrompt(prompt)).toBe('help');
    }
  });
});

describe('the routing reply', () => {
  const reply = routeReply('add pagination to the users endpoint', decide());

  it('names the model, its cost and the evidence behind the estimate', () => {
    expect(reply.markdown).toContain('acme/fast-1');
    expect(reply.markdown).toContain('Expected total cost');
    expect(reply.markdown).toContain('configured prior, not a measurement');
  });

  it('says plainly that nothing was executed', () => {
    // The single most important sentence in the participant. A user who thinks
    // the work has started will not start it themselves.
    expect(reply.markdown).toContain('Nothing has been executed');
    expect(reply.markdown).toContain('does not run one');
  });

  it('names the escalation target when there is one', () => {
    expect(reply.markdown).toContain('escalates to');
  });

  it('offers useful follow-ups', () => {
    expect(reply.followUps.map((entry) => entry.command)).toEqual([
      COMMANDS.explain,
      COMMANDS.history,
    ]);
  });

  it('handles a decision that selected nothing', () => {
    const stopped = routeReply(
      'a task',
      decide({ requestBudget: 0.0000001, onBudgetExceeded: 'stop' }),
    );

    expect(stopped.markdown).toContain('No model selected');
    expect(stopped.markdown).toContain('Nothing was executed');
  });
});

describe('the explanation reply', () => {
  it('is the full explanation document', () => {
    const reply = explainReply(decide());

    expect(reply.markdown).toContain('# RoutePilot decision');
    expect(reply.markdown).toContain('## Candidates');
  });

  it('says so when there is nothing to explain yet', () => {
    const reply = nothingToExplainReply();

    expect(reply.markdown).toContain('No routing decision has been made');
    expect(reply.followUps[0]?.command).toBe(COMMANDS.route);
  });
});

describe('the help reply states the boundary', () => {
  const reply = helpReply();

  it('says what it does', () => {
    expect(reply.markdown).toContain('chooses which coding model');
  });

  it('says what it does not do, without hedging', () => {
    expect(reply.markdown).toContain('do **not** write code');
  });
});

describe('no chat reply carries a secret', () => {
  const SECRET = 'sk-ant-api03-AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKKLLLL';

  it('redacts a key pasted into the prompt', () => {
    // A user pasting a failing request into chat is not exotic, and the prompt
    // is echoed back in the reply.
    const reply = routeReply(`fix the call using ${SECRET}`, decide());
    expect(reply.markdown).not.toContain(SECRET);
  });

  it('redacts a key that reached the decision reason', () => {
    const decision = decide();
    const poisoned: RoutingDecision = { ...decision, reason: `chosen because key=${SECRET}` };

    expect(routeReply('a task', poisoned).markdown).not.toContain(SECRET);
    expect(explainReply(poisoned).markdown).not.toContain(SECRET);
  });

  it('redacts a key in a decision that selected nothing', () => {
    const decision = decide({ requestBudget: 0.0000001, onBudgetExceeded: 'stop' });
    const poisoned: RoutingDecision = { ...decision, reason: `stopped: token ${SECRET}` };

    expect(routeReply('a task', poisoned).markdown).not.toContain(SECRET);
  });
});
