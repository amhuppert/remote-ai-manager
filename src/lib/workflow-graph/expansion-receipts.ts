/**
 * Expansion idempotency, caps, and receipts (D4 R6.3/R8) — the pure half.
 *
 * Everything here is a decision about a payload and a ledger, with no
 * repository and no clock, so the whole idempotency and cap contract is
 * table-testable. {@link createGraphWorkflowExpansionService} owns the commits.
 *
 * Three ideas carry the slice:
 *
 * - **Canonical hashing.** A request's identity is the SHA-256 of its
 *   canonical (recursively key-sorted) JSON, taken after Zod parsing so
 *   defaults are already applied. Two bodies that differ only in key order or
 *   in an omitted-vs-defaulted field are the SAME request; anything else is a
 *   different one.
 *
 * - **Idempotency keyed on (invoking context, requestId).** A key with a
 *   matching hash replays its receipt; the same key under a different hash is
 *   refused as reuse. A key the ledger does not know — never recorded, or aged
 *   out of the refusal ring — is honestly a NEW attempt and is re-validated
 *   against current state. That last clause is why the design does not promise
 *   identical re-refusal forever (decision D5): a bounded ring cannot keep a
 *   promise about attempts it has forgotten, so requestIds are single-use.
 *
 * - **Caps counted from receipts, not from the graph.** The per-invoker and
 *   cumulative context budgets read the permanent acceptance ledger, so
 *   removing a generated context never returns budget and the caps are
 *   monotone.
 */

import { EXPANSION_CAPS } from "./expansion-caps";
import type {
  GraphWorkflowExpansionAcceptanceReceipt,
  GraphWorkflowExpansionReceipts,
  GraphWorkflowExpansionRefusalReceipt,
} from "./schemas";

/** The empty ledger — an execution no lane has ever expanded. */
export const EMPTY_EXPANSION_RECEIPTS: GraphWorkflowExpansionReceipts = {
  accepted: [],
  refusals: [],
};

export interface ExpansionCapRefusal {
  code: string;
  message: string;
}

/**
 * The per-request ceilings, decided from the payload alone. Exact: a request AT
 * a ceiling passes, one past it is refused. Checked before compilation so an
 * oversized batch never reaches the (more expensive) envelope walk.
 */
export function checkExpansionRequestCaps(request: {
  contexts: readonly unknown[];
  tasks: readonly unknown[];
  edges: readonly unknown[];
  canonicalBytes: number;
}): ExpansionCapRefusal | null {
  if (request.contexts.length > EXPANSION_CAPS.contextsPerRequest) {
    return {
      code: "expansion-cap-contexts-per-request",
      message: `One expansion may create at most ${EXPANSION_CAPS.contextsPerRequest} contexts; this request declares ${request.contexts.length}`,
    };
  }
  if (request.tasks.length > EXPANSION_CAPS.tasksPerRequest) {
    return {
      code: "expansion-cap-tasks-per-request",
      message: `One expansion may create at most ${EXPANSION_CAPS.tasksPerRequest} tasks; this request declares ${request.tasks.length}`,
    };
  }
  if (request.edges.length > EXPANSION_CAPS.edgesPerRequest) {
    return {
      code: "expansion-cap-edges-per-request",
      message: `One expansion may add at most ${EXPANSION_CAPS.edgesPerRequest} edges; this request declares ${request.edges.length}`,
    };
  }
  if (request.canonicalBytes > EXPANSION_CAPS.canonicalPayloadBytes) {
    return {
      code: "expansion-cap-payload-bytes",
      message: `One expansion payload may be at most ${EXPANSION_CAPS.canonicalPayloadBytes} canonical bytes; this request is ${request.canonicalBytes}`,
    };
  }
  return null;
}

/** Expansion-created contexts across the whole execution, all invokers. */
export function countExpansionCreatedContexts(
  receipts: GraphWorkflowExpansionReceipts,
): number {
  return receipts.accepted.reduce(
    (total, receipt) => total + receipt.addedContextIds.length,
    0,
  );
}

/** Expansion-created contexts attributable to one invoking context. */
export function countExpansionCreatedContextsFor(
  receipts: GraphWorkflowExpansionReceipts,
  invokerContextId: string,
): number {
  return receipts.accepted
    .filter((receipt) => receipt.invokerContextId === invokerContextId)
    .reduce((total, receipt) => total + receipt.addedContextIds.length, 0);
}

/**
 * The budget ceilings, decided from the permanent acceptance ledger plus what
 * this request would add. Counting receipts rather than live contexts is what
 * makes the budget monotone: a removed generated context stays spent.
 */
export function checkExpansionBudgetCaps(input: {
  receipts: GraphWorkflowExpansionReceipts;
  invokerContextId: string;
  newContextCount: number;
}): ExpansionCapRefusal | null {
  const perInvoker =
    countExpansionCreatedContextsFor(input.receipts, input.invokerContextId) +
    input.newContextCount;
  if (perInvoker > EXPANSION_CAPS.contextsPerAddingContext) {
    return {
      code: "expansion-cap-contexts-per-adding-context",
      message: `Context "${input.invokerContextId}" may create at most ${EXPANSION_CAPS.contextsPerAddingContext} contexts across all its expansions; this request would bring it to ${perInvoker}`,
    };
  }

  const cumulative =
    countExpansionCreatedContexts(input.receipts) + input.newContextCount;
  if (cumulative > EXPANSION_CAPS.contextsPerExecution) {
    return {
      code: "expansion-cap-contexts-per-execution",
      message: `This execution may create at most ${EXPANSION_CAPS.contextsPerExecution} contexts through expansion; this request would bring it to ${cumulative}`,
    };
  }

  return null;
}

/** The refusal code a reused single-use requestId is refused under. */
export const EXPANSION_REQUEST_ID_REUSED = "expansion-request-id-reused";

export type ExpansionAttemptVerdict =
  /** Nothing in the ledger knows this key: validate it against current state. */
  | { kind: "new" }
  /** Same key, same payload, already accepted: replay, mutate nothing. */
  | { kind: "replay"; receipt: GraphWorkflowExpansionAcceptanceReceipt }
  /** Same key, same payload, already refused: answer identically. */
  | { kind: "replay-refusal"; receipt: GraphWorkflowExpansionRefusalReceipt }
  /** Same key, DIFFERENT payload: a single-use id used twice. */
  | { kind: "reused"; priorPayloadHash: string };

/**
 * Classify one attempt against the ledger.
 *
 * Acceptances are consulted before refusals so a key that was refused and later
 * accepted (a transient refusal the lane fixed, e.g. a rejoin target that had
 * not settled yet) replays its acceptance rather than its stale refusal.
 */
export function classifyExpansionAttempt(input: {
  receipts: GraphWorkflowExpansionReceipts;
  invokerContextId: string;
  requestId: string;
  payloadHash: string;
}): ExpansionAttemptVerdict {
  const matchesKey = (receipt: {
    invokerContextId: string;
    requestId: string;
  }): boolean =>
    receipt.invokerContextId === input.invokerContextId &&
    receipt.requestId === input.requestId;

  const accepted = input.receipts.accepted.find(matchesKey);
  if (accepted) {
    return accepted.payloadHash === input.payloadHash
      ? { kind: "replay", receipt: accepted }
      : { kind: "reused", priorPayloadHash: accepted.payloadHash };
  }

  const refused = input.receipts.refusals.find(matchesKey);
  if (refused) {
    return refused.payloadHash === input.payloadHash
      ? { kind: "replay-refusal", receipt: refused }
      : { kind: "reused", priorPayloadHash: refused.payloadHash };
  }

  return { kind: "new" };
}

/** The message a reused single-use requestId is refused with. */
export function expansionReuseMessage(
  requestId: string,
  invokerContextId: string,
): string {
  return `requestId "${requestId}" was already used by context "${invokerContextId}" for a different payload; expansion requestIds are single-use`;
}

/**
 * Append a permanent acceptance receipt. The cumulative cap is enforced before
 * a request is admitted, so the ledger cannot exceed its schema bound here.
 */
export function recordExpansionAcceptance(
  receipts: GraphWorkflowExpansionReceipts,
  receipt: GraphWorkflowExpansionAcceptanceReceipt,
): GraphWorkflowExpansionReceipts {
  return {
    accepted: [...receipts.accepted, receipt],
    refusals: receipts.refusals,
  };
}

/**
 * Append a refusal receipt to the bounded ring, evicting the oldest entries
 * past {@link EXPANSION_CAPS.refusalRingSize}. Re-recording the same
 * (invoker, requestId, payloadHash) replaces the prior entry rather than
 * accumulating duplicates, so a ring under retry pressure keeps holding twenty
 * DISTINCT attempts instead of twenty copies of one.
 */
export function recordExpansionRefusal(
  receipts: GraphWorkflowExpansionReceipts,
  receipt: GraphWorkflowExpansionRefusalReceipt,
): GraphWorkflowExpansionReceipts {
  const withoutDuplicate = receipts.refusals.filter(
    (existing) =>
      !(
        existing.invokerContextId === receipt.invokerContextId &&
        existing.requestId === receipt.requestId &&
        existing.payloadHash === receipt.payloadHash
      ),
  );
  return {
    accepted: receipts.accepted,
    refusals: [...withoutDuplicate, receipt].slice(
      -EXPANSION_CAPS.refusalRingSize,
    ),
  };
}

export interface ExpansionProvenance {
  nodeKind: "context" | "task";
  receipt: GraphWorkflowExpansionAcceptanceReceipt;
}

/**
 * Which accepted expansion created this context or task, or `null` for a node
 * the planner authored. This is the node-level half of R8's provenance
 * requirement: the receipt names the initiator, the rationale, and the payload
 * hash, so any generated id resolves to who asked for it and why.
 */
export function resolveExpansionProvenance(
  receipts: GraphWorkflowExpansionReceipts,
  nodeId: string,
): ExpansionProvenance | null {
  for (const receipt of receipts.accepted) {
    if (receipt.addedContextIds.includes(nodeId)) {
      return { nodeKind: "context", receipt };
    }
    if (receipt.addedTaskIds.includes(nodeId)) {
      return { nodeKind: "task", receipt };
    }
  }
  return null;
}
