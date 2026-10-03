import type { WorkspaceBindingRequest } from "@/lib/workspace/schemas";
import type { ContextContract, ContextFacts, ContextPolicy } from "./schemas";

/** The facts of a Context that has not started any work. */
export function initialContextFacts(input: {
  contextId: string;
  workspace: WorkspaceBindingRequest;
  contract: ContextContract;
  policy: ContextPolicy;
}): ContextFacts {
  return {
    contextId: input.contextId,
    binding: { request: input.workspace, bound: false, released: false },
    contract: { revision: 1, current: input.contract, amendments: [] },
    policy: input.policy,
    seats: { conversations: {}, replacements: {} },
    ledger: {
      revision: 0,
      tasks: input.contract.tasks.map((task) => ({
        id: task.id,
        title: task.title,
        ...(task.instructions !== undefined
          ? { instructions: task.instructions }
          : {}),
        source: "contract",
        status: "open",
      })),
      settledWorkTurns: 0,
      lastSummary: null,
    },
    candidates: {
      sequence: 0,
      items: [],
      retired: [],
      captured: null,
      captureFailures: null,
      unstableCount: 0,
      verifyPending: null,
      nextProvenance: { kind: "work" },
    },
    certification: { sequence: 0, rounds: [] },
    advice: { dispositions: {}, correctionFailures: 0 },
    approval: { decisions: [], reworked: [] },
    acceptance: { receipts: [] },
    allowances: {
      granted: { unfinishedTaskRetries: 0, validationRetries: 0 },
      charges: [],
    },
    control: { paused: false, cancelled: false, halt: null, steers: [] },
    requests: { open: [], answered: [] },
    effectSequence: 0,
  };
}
