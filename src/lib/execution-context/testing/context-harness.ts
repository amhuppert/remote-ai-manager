import { advanceContext, type ContextInput } from "../advance";
import { planEffects, waitsOnPerson, type PlannedEffect } from "../effects";
import { initialContextFacts } from "../facts";
import { applyTaskCommand, type TaskCommand } from "../ledger";
import { deriveProgress } from "../progress";
import type { ConversationReport, WorkspaceReport } from "../reports";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextContract,
  type ContextFacts,
  type ContextPolicy,
  type ReviewerAssignment,
} from "../schemas";

/**
 * Drives a Context's facts through the production chain (plan, settle,
 * advance) without a host, for tests of the chain and of what it shows.
 */

export const seat = {
  profile: { tier: "builtin" as const, id: "general-reviewer" },
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

export function contract(
  overrides: Partial<ContextContract> = {},
): ContextContract {
  return contextContractSchema.parse({
    title: "Fix the duplicate notice",
    brief: "Make the failure notice appear once.",
    tasks: [{ id: "t1", title: "Fix it" }],
    acceptanceCriteria: [{ id: "ac-1", text: "One notice per failure" }],
    outputSchema: null,
    allowTaskAddition: false,
    implementer: { id: "implementer", ...seat },
    reviewers: [],
    checks: [],
    humanApproval: false,
    ownerQuestions: true,
    documents: [],
    ...overrides,
  });
}

export function reviewer(
  id: string,
  authority: "blocking" | "advisory",
): ReviewerAssignment {
  return { id, authority, ...seat };
}

export function workReport(
  overrides: Partial<ConversationReport> = {},
): ConversationReport {
  return {
    status: "succeeded",
    conversationId: "conv-impl",
    finalText: "Done.",
    structuredOutput: null,
    outputIssue: null,
    openQuestionId: null,
    failure: null,
    ...overrides,
  };
}

export function verdictReport(
  verdict: "pass" | "fail" | "plan_defect",
  extra: {
    findings?: unknown[];
    advisories?: unknown[];
    conversationId?: string;
  } = {},
): ConversationReport {
  return workReport({
    conversationId: extra.conversationId ?? "conv-review",
    structuredOutput: {
      verdict,
      findings: extra.findings ?? [],
      advisories: extra.advisories ?? [],
    },
  });
}

export const binding = {
  kind: "session" as const,
  projectPath: "/repo",
  sessionName: "session",
  worktreePath: "/repo/.worktrees/session",
  scope: { mode: "full" as const },
};

/** A context whose workspace binding was admitted. */
export function harness(
  c: ContextContract,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
) {
  const h = unboundHarness(c, policy);
  expectKinds(h.step(), ["bind"]);
  h.settle("bind", { kind: "bound" });
  return h;
}

export function unboundHarness(
  c: ContextContract,
  policy: ContextPolicy = DEFAULT_CONTEXT_POLICY,
) {
  let facts: ContextFacts = initialContextFacts({
    contextId: "ctx",
    workspace: binding,
    contract: c,
    policy,
  });
  let pending: PlannedEffect[] = [];
  let now = "2026-10-03T10:00:00.000Z";
  return {
    get facts() {
      return facts;
    },
    /** Moves the clock the next plan reads. */
    setNow(at: string): void {
      now = at;
    },
    get pending() {
      return pending;
    },
    step(): PlannedEffect[] {
      if (pending.length > 0) return [];
      const planned = planEffects({ facts, othersPending: false, now });
      facts = planned.facts;
      pending = planned.effects;
      return planned.effects;
    },
    settle(
      kind: PlannedEffect["request"]["kind"],
      outcome: unknown,
      index = 0,
    ): void {
      const effect = pending.filter((e) => e.request.kind === kind)[index];
      if (effect === undefined) throw new Error(`No pending ${kind} effect`);
      facts = advanceContext(facts, {
        kind: "outcome",
        cause: effect.cause,
        request: effect.request,
        state: { kind: "settled", outcome },
        at: now,
      });
      pending = pending.filter((e) => e !== effect);
    },
    settleUncertain(kind: PlannedEffect["request"]["kind"]): void {
      const effect = pending.find((e) => e.request.kind === kind);
      if (effect === undefined) throw new Error(`No pending ${kind} effect`);
      facts = advanceContext(facts, {
        kind: "outcome",
        cause: effect.cause,
        request: effect.request,
        state: { kind: "uncertain", evidence: "process exited mid-turn" },
        at: now,
      });
      pending = pending.filter((e) => e !== effect);
    },
    input(input: ContextInput): void {
      facts = advanceContext(facts, input);
    },
    task(command: TaskCommand): void {
      const result = applyTaskCommand(facts, command);
      if (result.kind === "refused") throw new Error(result.reason);
      facts = result.facts;
    },
    progress(admitted = true) {
      return deriveProgress(
        facts,
        pending.map((e) => ({
          cause: e.cause,
          admitted,
          waitsOnPerson: waitsOnPerson(e.request),
        })),
      );
    },
  };
}

export const frozen = (evidence: string): WorkspaceReport => ({
  kind: "frozen",
  evidence,
});

/** Runs one work turn that completes every task, then freezes the result. */
export function workAndFreeze(
  h: ReturnType<typeof harness>,
  evidence = "ev-1",
): void {
  expectKinds(h.step(), ["work"]);
  for (const task of h.facts.ledger.tasks) {
    if (task.status === "open") h.task({ kind: "complete", taskId: task.id });
  }
  h.settle("work", workReport());
  expectKinds(h.step(), ["freeze"]);
  h.settle("freeze", frozen(evidence));
}

function expectKinds(effects: PlannedEffect[], kinds: string[]): void {
  const planned = effects.map((e) => e.request.kind);
  if (planned.join(",") !== kinds.join(","))
    throw new Error(
      `Planned ${planned.join(", ") || "nothing"}, not ${kinds.join(", ")}`,
    );
}
