/**
 * Presentation projection for the global validation budget indicator.
 *
 * Pure: the wire response in, everything the gauge and its detail panel draw
 * out. Kept out of the component so the copy decisions — which are the only
 * non-obvious part — are testable without rendering.
 */

import { conversationsPageHref } from "@/lib/conversations/hrefs";
import type {
  ValidationBudgetResponse,
  ValidationBudgetRun,
} from "@/lib/validation/api-schemas";

/** Queued runs listed before the panel collapses the rest into a count. */
export const QUEUE_PREVIEW_LIMIT = 3;

/**
 * Allocation segments narrower than this render unlabelled — at one unit the
 * segment is too thin to seat a command name without clipping it.
 */
const SEGMENT_LABEL_MIN_UNITS = 2;

export interface ValidationBudgetSegment {
  kind: "run" | "free";
  units: number;
  /** Command name when the segment is wide enough to seat one. */
  label: string | null;
  runId: string | null;
}

export interface ValidationBudgetRow {
  runId: string;
  commandName: string;
  projectName: string;
  cost: number;
  /** Null when the run belongs to no navigable surface. */
  href: string | null;
  /** 1-based place in the queue; null while running. */
  queuePosition: number | null;
}

export interface ValidationBudgetView {
  limit: number;
  inUse: number;
  free: number;
  queueDepth: number;
  /** Share of the budget in use, clamped to 0..1 for the ring. */
  fraction: number;
  /** `active` = running freely; `saturated` = work is waiting on capacity. */
  tone: "active" | "saturated";
  compactLabel: string;
  headline: string;
  detail: string;
  allocation: ValidationBudgetSegment[];
  allocationCaption: string;
  running: ValidationBudgetRow[];
  queued: ValidationBudgetRow[];
  queuedOverflow: number;
}

/**
 * Where a run's row navigates, degrading with what the run knows about
 * itself: its conversation, then its session, then its project. System-owned
 * runs carry neither conversation nor session and land on the project.
 */
export function validationRunHref(run: ValidationBudgetRun): string | null {
  const project = `/projects/${encodeURIComponent(run.projectName)}`;
  if (run.conversationId !== null) {
    // A session conversation is addressed by id on the conversations page; a
    // project conversation is focused inside its project (the same split
    // `activeConversationHref` makes).
    return run.sessionName !== null
      ? conversationsPageHref({ conversationId: run.conversationId })
      : `${project}?focus=${encodeURIComponent(run.conversationId)}`;
  }
  if (run.sessionName !== null) {
    return `${project}/${encodeURIComponent(run.sessionName)}`;
  }
  return project;
}

function units(count: number): string {
  return count === 1 ? "1 unit" : `${count} units`;
}

function toRow(
  run: ValidationBudgetRun,
  queuePosition: number | null,
): ValidationBudgetRow {
  return {
    runId: run.runId,
    commandName: run.commandName,
    projectName: run.projectName,
    cost: run.cost,
    href: validationRunHref(run),
    queuePosition,
  };
}

/**
 * The one sentence under the headline. Strict FIFO is what makes the
 * interesting case interesting: the scheduler never skips a queue head that
 * does not fit, so free units can sit unusable while other runs wait.
 *
 * That case names the HEAD's cost rather than claiming nothing in the queue
 * fits. A smaller run further back may well fit the free units — it still
 * cannot start, and saying otherwise is a false claim about the queue (live
 * case: 2 units free, head 4u, a 2u run waiting behind it).
 */
function describeState(
  free: number,
  queueDepth: number,
  headCost: number | null,
): string {
  if (free === 0) {
    return queueDepth > 0
      ? `At capacity — ${queueDepth} queued`
      : "At capacity";
  }
  if (queueDepth === 0) return `${units(free)} free · queue empty`;
  if (headCost !== null && headCost > free) {
    return `${units(free)} free — next up needs ${headCost}u`;
  }
  return `${units(free)} free · ${queueDepth} queued`;
}

/** Null when there is nothing to report — the indicator hides entirely. */
export function buildValidationBudgetView(
  response: ValidationBudgetResponse,
): ValidationBudgetView | null {
  const { available, capacity, runs } = response;
  const { limit, inUse, queueDepth } = capacity;
  // A closed admission gate makes the numbers meaningless, and an idle budget
  // has nothing to explain; both cases drop the chrome rather than report a
  // zero.
  if (!available) return null;
  if (inUse === 0 && queueDepth === 0) return null;

  // Widest first: the allocation bar reads as a descending stack, and the
  // running list matches it so a segment and its row line up.
  const running = runs
    .filter((entry) => entry.status === "running")
    .sort((a, b) => b.cost - a.cost);
  // The panel only ever shows the head of the queue, so a row's index within
  // the sorted queue IS its FIFO position.
  const queued = runs
    .filter((entry) => entry.status === "queued")
    .sort(
      (a, b) =>
        (a.position ?? Number.MAX_SAFE_INTEGER) -
        (b.position ?? Number.MAX_SAFE_INTEGER),
    );

  const free = Math.max(0, limit - inUse);
  const allocation: ValidationBudgetSegment[] = running.map((entry) => ({
    kind: "run" as const,
    units: entry.cost,
    label: entry.cost >= SEGMENT_LABEL_MIN_UNITS ? entry.commandName : null,
    runId: entry.runId,
  }));
  if (free > 0) {
    allocation.push({ kind: "free", units: free, label: null, runId: null });
  }

  const allocated =
    running.length === 0 ? "0" : running.map((entry) => entry.cost).join(" + ");

  return {
    limit,
    inUse,
    free,
    queueDepth,
    fraction: limit > 0 ? Math.min(1, inUse / limit) : 0,
    // Amber is CC's "awaiting" tone, so the gauge turns the moment work is
    // waiting on capacity rather than at an arbitrary utilization threshold.
    tone: queueDepth > 0 ? "saturated" : "active",
    compactLabel: `${inUse}/${limit}`,
    headline: `${inUse} of ${limit} ${limit === 1 ? "unit" : "units"}`,
    detail: describeState(free, queueDepth, queued[0]?.cost ?? null),
    allocation,
    allocationCaption: `${allocated} allocated · ${free} free of ${limit}`,
    running: running.map((entry) => toRow(entry, null)),
    queued: queued
      .slice(0, QUEUE_PREVIEW_LIMIT)
      .map((entry, index) => toRow(entry, index + 1)),
    queuedOverflow: Math.max(0, queueDepth - QUEUE_PREVIEW_LIMIT),
  };
}
