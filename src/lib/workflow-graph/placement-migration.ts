/**
 * Placement migration: how a document authored before lane placement existed
 * inflates into one that has it (R11, decision D13).
 *
 * Placement is REQUIRED on both the authored and the resolved context, because
 * it is the only lane authority — an optional one would resurrect the
 * deterministic assignment locked fork F1 deleted. That leaves every stored
 * definition, template, and execution written before the field a document the
 * strict parse would refuse, so the refusal is pre-empted here instead: at the
 * inflate boundary, before the parse, never at authoring.
 *
 * The encoding restores the semantics the document was authored under — one
 * worktree per context — by giving every context a lane of its own, named after
 * it. A context id may be any non-empty string; a lane name becomes a git
 * branch segment and a filesystem path segment, so the id is sanitized into
 * `laneIdViolation`'s charset and de-duplicated by ordinal suffix. The result is
 * deterministic: the same stored bytes migrate to the same lanes on every load,
 * so an id-addressed reference taken from one read is still valid on the next.
 *
 * Dependency-light on purpose (mirroring `edge-identity.ts`): reached from the
 * state-store read path, the workflow storage read path, and the cutover
 * guards.
 */

import { SESSION_LANE_ID } from "./lane-join";
import { SESSION_LANE_NAME } from "./lane-identity";

/** What a context whose id sanitizes to nothing legal is named. */
const FALLBACK_LANE_NAME = "context";

/**
 * Sanitize a context id into the lane-id charset.
 *
 * Each step erases one way `laneIdViolation` can refuse a name, in the order
 * that keeps the steps independent: out-of-charset characters first (so `/`
 * becomes an ordinary character rather than a path separator), then parent
 * segments, then the illegal leading and trailing characters, and last the
 * `.lock` suffix git reserves for its own lock files.
 */
function sanitizeLaneName(contextId: string): string {
  const sanitized = contextId
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .replace(/\.\./g, "_")
    .replace(/^[.-]+/, "")
    .replace(/[.-]+$/, "");
  if (sanitized.length === 0) return FALLBACK_LANE_NAME;
  return sanitized.endsWith(".lock") ? `${sanitized}_` : sanitized;
}

/**
 * `<sanitized>`, then `-2`, `-3` … by ordinal — the same minting shape edge ids
 * use. Distinct context ids that sanitize to one segment (`build api` and
 * `build/api`) must stay on distinct lanes: merging them would put two contexts
 * that were never scoped against each other into one worktree.
 */
function mintLaneName(taken: ReadonlySet<string>, contextId: string): string {
  const base = sanitizeLaneName(contextId);
  if (!taken.has(base)) return base;
  let ordinal = 2;
  while (taken.has(`${base}-${ordinal}`)) ordinal += 1;
  return `${base}-${ordinal}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Give every placement-less context of a RAW (not yet schema-parsed) definition
 * its own full-access lane, in place.
 *
 * Idempotent and order-stable: contexts are visited in array order, an already
 * authored placement is left exactly as found and its lane is reserved, and
 * only the remainder are minted around it. Re-running over the result changes
 * nothing.
 *
 * A context without a usable id is left alone — it cannot be minted from, and
 * the parse refuses it with a locator that names the real problem.
 */
export function migrateRawDefinitionPlacement(rawDefinition: unknown): void {
  if (!isRecord(rawDefinition)) return;

  // Both session lane spellings are refused as group-lane names, so a context
  // literally called `session` must be encoded away from it rather than onto
  // it. Seeding the reserved set is what turns that into a suffix.
  const taken = new Set<string>([SESSION_LANE_NAME, SESSION_LANE_ID]);
  const pending: Array<Record<string, unknown>> = [];

  for (const context of collectRawContexts(rawDefinition)) {
    const placement = context.placement;
    if (isRecord(placement) && typeof placement.lane === "string") {
      taken.add(placement.lane);
      continue;
    }
    pending.push(context);
  }

  for (const context of pending) {
    if (typeof context.id !== "string" || context.id.length === 0) continue;
    const lane = mintLaneName(taken, context.id);
    taken.add(lane);
    context.placement = { lane, mode: "full" };
  }
}

/**
 * Every context array a definition can carry: its own, plus the frozen body of
 * each resolved loop group. A loop template holds RESOLVED contexts, which the
 * same required placement applies to — a pass instance is cloned from them, so
 * a template context without placement would produce an unschedulable instance.
 */
function collectRawContexts(
  rawDefinition: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const contexts: Array<Record<string, unknown>> = [];
  const push = (value: unknown): void => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (isRecord(entry)) contexts.push(entry);
    }
  };

  push(rawDefinition.executionContexts);
  if (Array.isArray(rawDefinition.loopGroups)) {
    for (const group of rawDefinition.loopGroups) {
      if (!isRecord(group) || !isRecord(group.template)) continue;
      push(group.template.contexts);
    }
  }
  return contexts;
}

/**
 * The execution-tier half: migrate the working definition and drop the removed
 * `lanePlan` field (R2.1), in place, before the parse.
 *
 * Dropping is explicit rather than left to the schema's key stripping: the
 * codec re-serializes what it parsed back into the row, and a field that is
 * only ever stripped on read stays in the stored bytes of every archived
 * execution, which nothing else rewrites.
 */
export function migrateRawExecutionPlacement(rawExecution: unknown): void {
  if (!isRecord(rawExecution)) return;
  delete rawExecution.lanePlan;
  migrateRawDefinitionPlacement(rawExecution.workingDefinition);
}
