import type { SeatTurnPort, SeatTurnResult } from "@/lib/conversation-core/executor";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextContract,
  type ContextStartRequest,
} from "@/lib/execution-context/schemas";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type { RunBoundary } from "../schemas";
import { composeRunSupervision, type RunSupervision } from "../supervision";

const silent = { info: () => {}, warn: () => {}, error: () => {} };

export const done = (finalText: string): SeatTurnResult => ({
  status: "succeeded",
  finalText,
  structuredOutput: null,
  outputIssue: null,
  failure: null,
  backendRef: null,
});

export type TurnScript = (
  input: Parameters<SeatTurnPort["run"]>[0],
  supervision: RunSupervision,
) => Promise<SeatTurnResult>;

export function agentStartRequest(runId: string, contract: Partial<ContextContract> = {}): ContextStartRequest {
  return {
    contextId: `${runId}.agent`,
    runId,
    ownerConversationId: "owner-1",
    workspace: {
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "full" },
    },
    contract: contextContractSchema.parse({
      title: "Fix the notice",
      brief: "Make the failure notice appear once.",
      tasks: [],
      acceptanceCriteria: [],
      outputSchema: null,
      allowTaskAddition: false,
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "standard-agent" },
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: {} },
      },
      reviewers: [],
      checks: [],
      humanApproval: false,
      ownerQuestions: true,
      documents: [],
      ...contract,
    }),
    policy: DEFAULT_CONTEXT_POLICY,
  };
}

/**
 * The real supervision graph on a persistence fixture, with only the edges
 * that leave CC faked: seat turns follow `script`, Git evidence is constant,
 * checks pass, and owner notices are recorded.
 */
export function createSupervisionHarness(fixture: PersistenceFixture) {
  const harness = {
    notified: [] as RunBoundary[],
    turnMessages: [] as string[],
    script: (async () => done("Done.")) as TurnScript,
    conversations: 0,
    compose(): RunSupervision {
      let self: RunSupervision | null = null;
      const supervision = composeRunSupervision({
        db: fixture.db,
        seatTurns: {
          async run(input) {
            harness.turnMessages.push(input.request.message);
            if (self === null) throw new Error("not composed");
            return harness.script(input, self);
          },
        },
        async createSeatConversation() {
          harness.conversations += 1;
          return `conv-${harness.conversations}`;
        },
        slots: { tryAcquire: async () => () => {}, waitForRelease: async () => {} },
        evidence: {
          capture: async () => "git:tree:digest",
          sameContent: (a, b) => a === b,
          changedPaths: async () => [],
        },
        runCheck: async () => ({ status: "passed" }),
        async notifyOwner({ boundary }) {
          harness.notified.push(boundary);
        },
        now: () => new Date().toISOString(),
        logger: () => silent,
      });
      self = supervision;
      return supervision;
    },
  };
  return harness;
}

/** Lets every reconcile, turn and workspace operation run; `turnsSettle: false` skips waiting on turns. */
export async function quiesce(s: RunSupervision, turnsSettle = true): Promise<void> {
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await Promise.all([s.scheduler.idle(), turnsSettle ? s.core.idle() : null, s.workspace.drain()]);
  }
}
