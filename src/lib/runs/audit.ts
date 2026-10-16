import type { ConversationCore } from "@/lib/conversation-core/executor";
import type {
  PromptDispatchEvidence,
  SeatBindingRecord,
} from "@/lib/conversation-core/schemas";
import type { ContextHost } from "@/lib/execution-context/host";
import type { ContextRecord } from "@/lib/execution-context/schemas";
import type {
  WorkspaceOperationRecord,
  PublicationWait,
} from "@/lib/workspace/schemas";
import type { SubscriptionDelivery } from "@/lib/subscriptions/schemas";
import type { SubscriptionWakeBatch } from "@/lib/subscriptions/active-wait-schemas";
import type { RunHost } from "./host";
import {
  runAuditQuerySchema,
  type RunAudit,
  type RunAuditQuery,
  type RunAuditContext,
  type RunAuditConversationFacts,
} from "./schemas";

export interface RunAuditSources {
  runs: Pick<RunHost, "observe">;
  contexts: Pick<ContextHost, "observe">;
  core: Pick<ConversationCore, "seatBindingsOf">;
  workspace: {
    operationsOf(
      requester: WorkspaceOperationRecord["requester"],
    ): WorkspaceOperationRecord[];
    waitingOn(cause: string): PublicationWait | null;
  };
  deliveriesForRun(
    projectPath: string,
    runId: string,
  ): Promise<SubscriptionDelivery[]>;
  wakeBatchesForDeliveries(
    deliveryIds: string[],
  ): Promise<SubscriptionWakeBatch[]>;
  promptDispatches(
    conversationId: string,
  ): Promise<PromptDispatchEvidence[] | null>;
  conversationFacts(
    projectPath: string,
    sessionName: string,
  ): Promise<ReadonlyMap<string, RunAuditConversationFacts>>;
}

export class RunAuditContextNotFoundError extends Error {
  constructor(contextId: string) {
    super(`Context ${contextId} is not part of this run`);
    this.name = "RunAuditContextNotFoundError";
  }
}

export async function buildRunAudit(
  sources: RunAuditSources,
  runId: string,
  query: RunAuditQuery = {},
): Promise<RunAudit | null> {
  const selection = runAuditQuerySchema.parse(query);
  const observation = sources.runs.observe(runId);
  if (!observation) return null;
  const { record: run, boundaries } = observation;
  const latest = new Map(
    run.facts.invocations.map((item) => [item.key, item.contextId]),
  );
  const rows = [
    ...run.facts.invocations.map((item) => ({
      key: item.key,
      pass: item.pass + 1,
      contextId: item.contextId,
      started: true,
      current: latest.get(item.key) === item.contextId,
    })),
    ...run.facts.definition.contexts
      .filter((item) => !latest.has(item.key))
      .map((item) => ({
        key: item.key,
        pass: 0,
        contextId: item.request.contextId,
        started: false,
        current: true,
      })),
  ].map((row) => {
    const record = row.started
      ? (sources.contexts.observe(row.contextId)?.record ?? null)
      : null;
    const bindings = sources.core.seatBindingsOf(row.contextId);
    const agents = agentsOf(record, bindings);
    const counts = {
      conversations: agents.length,
      missingSeatBindings: missingBindings(record, bindings),
      candidates: record?.facts.candidates.items.length ?? 0,
      reviewRounds: record?.facts.certification.rounds.length ?? 0,
      acceptances: record?.facts.acceptance.receipts.length ?? 0,
    };
    return { row, record, agents, counts };
  });
  const matching = selection.context
    ? rows.filter(({ row }) => row.contextId === selection.context)
    : rows;
  if (selection.context && matching.length === 0)
    throw new RunAuditContextNotFoundError(selection.context);
  const detail = selection.full || selection.context !== undefined;
  const conversations = detail
    ? await sources.conversationFacts(run.projectPath, run.sessionName)
    : new Map<string, RunAuditConversationFacts>();
  const offset = detail ? 0 : selection.offset;
  const page = detail
    ? matching
    : matching.slice(offset, offset + selection.limit);
  const operations = [
    ...sources.workspace.operationsOf({ kind: "run", id: runId }),
    ...run.facts.invocations.flatMap((item) =>
      sources.workspace.operationsOf({ kind: "context", id: item.contextId }),
    ),
  ];
  const deliveries = await sources.deliveriesForRun(run.projectPath, runId);
  const wakeBatches = await sources.wakeBatchesForDeliveries(
    deliveries.map((item) => item.id),
  );
  const items: RunAuditContext[] = [];
  for (const entry of page) {
    const { record, row, counts, agents } = entry;
    const item: RunAuditContext = {
      ...row,
      available: record !== null,
      progress: record?.progress.kind ?? null,
      counts,
    };
    if (detail) {
      const evidenceAgents: NonNullable<RunAuditContext["detail"]>["agents"] =
        [];
      for (const agent of agents) {
        const prompts = await sources.promptDispatches(agent.conversationId);
        evidenceAgents.push({
          ...agent,
          metadata: conversations.get(agent.conversationId) ?? null,
          prompts: {
            availability:
              prompts === null
                ? "unavailable"
                : prompts.length === 0
                  ? "not_recorded"
                  : "recorded",
            entries: prompts ?? [],
          },
        });
      }
      const facts = record?.facts;
      item.detail = {
        revision: record?.revision ?? null,
        createdAt: record?.createdAt ?? null,
        updatedAt: record?.updatedAt ?? null,
        progress: record?.progress ?? null,
        facts: facts
          ? {
              binding: facts.binding,
              contract: facts.contract,
              policy: facts.policy,
              seats: facts.seats,
              ledger: facts.ledger,
              candidates: facts.candidates,
              certification: facts.certification,
              advice: facts.advice,
              approval: facts.approval,
              acceptance: facts.acceptance,
              allowances: facts.allowances,
              control: facts.control,
              requests: facts.requests,
            }
          : null,
        agents: evidenceAgents,
      };
    }
    items.push(item);
  }
  const sum = (field: keyof RunAuditContext["counts"]) =>
    rows.reduce((total, row) => total + row.counts[field], 0);
  return {
    coverage: {
      contextSeatTranscripts: true,
      ephemeralLaneTaskTranscripts: false,
      providerWireRequests: false,
    },
    run: {
      runId,
      title: detail ? run.facts.title : run.facts.title.slice(0, 200),
      ...(!detail && run.facts.title.length > 200
        ? { titleOmittedChars: run.facts.title.length - 200 }
        : {}),
      kind: run.facts.kind,
      projectPath: run.projectPath,
      sessionName: run.sessionName,
      ownerConversationId: run.ownerConversationId,
      progress: run.progress.kind,
      revision: run.revision,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
    },
    selection: { ...selection, context: selection.context ?? null },
    totals: {
      definitions: run.facts.definition.contexts.length,
      invocations: run.facts.invocations.length,
      passes: run.facts.invocations.reduce(
        (maximum, item) => Math.max(maximum, item.pass + 1),
        0,
      ),
      unavailableContexts: rows.filter(
        ({ row, record }) => row.started && !record,
      ).length,
      conversations: sum("conversations"),
      missingSeatBindings: sum("missingSeatBindings"),
      candidates: sum("candidates"),
      reviewRounds: sum("reviewRounds"),
      acceptances: sum("acceptances"),
      boundaries: boundaries.length,
      workspaceOperations: operations.length,
      deliveries: deliveries.length,
      wakeBatches: wakeBatches.length,
    },
    contexts: {
      total: matching.length,
      returned: items.length,
      offset,
      nextOffset:
        offset + items.length < matching.length ? offset + items.length : null,
      items,
    },
    ...(detail
      ? {
          evidence: {
            acts: run.facts.acts,
            boundaries,
            workspaceOperations: operations
              .filter(
                (operation) =>
                  !selection.context ||
                  operation.requester.kind === "run" ||
                  operation.requester.id === selection.context,
              )
              .map((operation) => ({
                operation,
                waitingOn: sources.workspace.waitingOn(operation.cause),
              })),
            deliveries,
            wakeBatches,
          },
        }
      : {}),
  };
}

function agentsOf(record: ContextRecord | null, bindings: SeatBindingRecord[]) {
  const current = record?.facts.seats.conversations;
  const agents: Array<
    Pick<
      NonNullable<RunAuditContext["detail"]>["agents"][number],
      "conversationId" | "assignmentId" | "current" | "binding"
    >
  > = bindings.map((binding) => ({
    conversationId: binding.conversationId,
    assignmentId: binding.assignmentId,
    current: current
      ? current[binding.assignmentId] === binding.conversationId
      : null,
    binding,
  }));
  for (const [assignmentId, conversationId] of Object.entries(current ?? {})) {
    if (!agents.some((agent) => agent.conversationId === conversationId))
      agents.push({
        conversationId,
        assignmentId,
        current: true,
        binding: null,
      });
  }
  return agents;
}

function missingBindings(
  record: ContextRecord | null,
  bindings: SeatBindingRecord[],
): number {
  if (!record) return 0;
  return Object.keys(record.facts.seats.conversations).reduce(
    (count, assignment) => {
      const expected = (record.facts.seats.replacements[assignment] ?? 0) + 1;
      const recorded = bindings.filter(
        (binding) => binding.assignmentId === assignment,
      ).length;
      return count + Math.max(0, expected - recorded);
    },
    0,
  );
}
