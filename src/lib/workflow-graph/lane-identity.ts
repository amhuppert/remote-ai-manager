/**
 * Lane identity for graph workflows: who a lane belongs to, and how that
 * identity is encoded everywhere a lane is addressed.
 *
 * A context is reviewed by an ordered cohort of validator assignments, so lane
 * KIND alone no longer identifies a lane. This module owns the one encoding
 * every addressing surface shares:
 *  - `laneIdViolation` / `validateLaneId` — the charset an authored lane name
 *    must satisfy to be spliceable into a branch name and a worktree path;
 *  - `laneStateKey` — the `execution.laneStates[contextId]` inner key;
 *  - `graphLaneId` / `parseGraphLaneId` — the primitive-layer lane id the
 *    shared `LaneStore`/`LaneService` stack addresses lanes by;
 *  - `assignmentFingerprint` — the immutable assignment a started lane holds.
 *
 * The implementer stays keyed by kind alone: one implementer per context is a
 * standing constraint, so an assignment segment there would encode nothing.
 *
 * Deliberately dependency-free (no `node:crypto`): the fingerprint is a
 * canonical join rather than a digest, so browser-project fixtures and the
 * authoring preview can compute it, and a mismatch names the field that moved
 * instead of two opaque hashes.
 */

import type { GraphWorkflowAgentConfig } from "@/lib/workflow-graph/config-schemas";
import { modelSelectionKey } from "@/lib/agent-backends/model-selection";
import {
  graphWorkflowLaneKindSchema,
  type GraphWorkflowLaneKind,
} from "@/lib/workflow-graph/schemas";

const LANE_ID_SEPARATOR = "\u0000";
const ASSIGNMENT_SEPARATOR = ":";

const LANE_ID_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The authored spelling of the session lane: the session worktree itself,
 * which hosts read-only contexts and is never provisioned as a group lane.
 *
 * The internal id the lane machinery addresses it by is
 * {@link SESSION_LANE_ID}. Both spellings are refused as authored GROUP lane
 * names — `session` because it denotes the session worktree rather than a
 * provisioned lane, `__session__` because an author writes `session`.
 */
export const SESSION_LANE_NAME = "session";

/**
 * The internal lane id for the session worktree itself. A lane record is
 * materialized under it when planning final-publish joins, so the lane
 * reachability machinery recognizes the session worktree as a join target like
 * any other lane.
 *
 * Deliberately outside `laneIdViolation`'s charset intersection with authored
 * names: an author writes {@link SESSION_LANE_NAME}, and this spelling is what
 * the engine uses so the two can never be confused for one another.
 */
export const SESSION_LANE_ID = "__session__";

/**
 * The runtime lane id an AUTHORED lane name addresses.
 *
 * Only the session lane is spelled differently at the two tiers — an author
 * writes {@link SESSION_LANE_NAME} and the engine keys its record under
 * {@link SESSION_LANE_ID} — so every surface that looks a placement's lane up in
 * `executionLanes`, `joins`, or a context state's `laneId` has to fold that one
 * name. Owning the fold here keeps the two spellings from drifting apart across
 * the readiness classifier, join planning, provisioning, and lane lifecycle.
 *
 * Total by construction: a group lane's authored name IS its runtime id.
 */
export function executionLaneIdFor(laneName: string): string {
  return laneName === SESSION_LANE_NAME ? SESSION_LANE_ID : laneName;
}

/**
 * Why `laneId` is unsafe to splice into a git branch name and a filesystem
 * path, or null when it is safe.
 *
 * The reason is RETURNED rather than thrown so definition validation can locate
 * an illegal authored lane name on the context that declared it, while the
 * provisioning callers keep the throwing form below. Lane ids and per-context
 * ids share these constraints — a single-context lane's id is its context id —
 * so this one grammar covers both.
 */
export function laneIdViolation(laneId: string): string | null {
  if (!LANE_ID_PATTERN.test(laneId)) {
    return "must match /^[A-Za-z0-9_.-]+$/";
  }
  if (laneId.startsWith(".") || laneId.startsWith("-")) {
    return "must not start with '.' or '-'";
  }
  if (laneId.includes("..")) {
    return "must not contain '..'";
  }
  if (laneId.endsWith(".") || laneId.endsWith("-")) {
    return "must not end with '.' or '-'";
  }
  if (laneId.endsWith(".lock")) {
    return "must not end with '.lock'";
  }
  return null;
}

/**
 * Validate that a lane id is safe to splice into a git branch name and a
 * filesystem path. The validator is exported under a context-named alias below
 * so callers that still address per-context lanes keep reading naturally.
 */
export function validateLaneId(laneId: string): void {
  const violation = laneIdViolation(laneId);
  if (violation !== null) {
    throw new Error(`Invalid laneId ${JSON.stringify(laneId)}: ${violation}`);
  }
}

/**
 * Characters a lane name may carry literally. `.` is deliberately absent even
 * though the grammar admits it: excluding it makes `..`, a trailing `.`, and a
 * `.lock` suffix unreachable in the output, so the encoder satisfies every rule
 * of the grammar by construction rather than by a post-hoc repair that would
 * cost injectivity.
 */
const LANE_NAME_LITERAL = /^[A-Za-z0-9-]$/;

const LANE_NAME_ESCAPE = "_";

/**
 * Turn an arbitrary non-empty id into a lane name: `laneIdViolation` returns
 * null for the result, whatever the id contained. (Emptiness is excluded by the
 * definition schema, which requires every context id to be non-empty, and an
 * empty lane name is the one thing no encoding can produce.)
 *
 * A lane name becomes a git branch name and a worktree path segment, so it must
 * satisfy the grammar above. An ID need not: a compiled execution context is
 * named from caller-assigned spec element ids and authored lane-group names,
 * both of which accept any non-empty string, so a context whose lane is "itself"
 * needs its id encoded rather than copied.
 *
 * Two properties make the encoding safe to use as an identity:
 *  - it is the IDENTITY on ids that already read as lane names, so the common
 *    case keeps a lane and its context spelled the same; and
 *  - it is INJECTIVE, so two contexts can never land on one lane that each
 *    believes it owns alone. `_` is the escape and doubles to encode itself;
 *    every other unit becomes a fixed-width `_XXXX` UTF-16 code-unit escape,
 *    which no `__` can be confused with because a hex digit is never `_`.
 *
 * Encoding walks code UNITS rather than code points: escaping a surrogate pair
 * as a single value would map distinct ids onto one lane.
 */
export function laneNameFromId(id: string): string {
  let lane = "";
  for (let index = 0; index < id.length; index += 1) {
    const unit = id.charAt(index);
    if (unit === LANE_NAME_ESCAPE) {
      lane += `${LANE_NAME_ESCAPE}${LANE_NAME_ESCAPE}`;
      continue;
    }
    // A lane name may not open or close on `-`, so those two positions are
    // escaped even though the character is otherwise literal.
    const atEdge = index === 0 || index === id.length - 1;
    if (LANE_NAME_LITERAL.test(unit) && !(atEdge && unit === "-")) {
      lane += unit;
      continue;
    }
    lane += `${LANE_NAME_ESCAPE}${id
      .charCodeAt(index)
      .toString(16)
      .padStart(4, "0")}`;
  }
  return lane;
}

/**
 * The lane name a context that names its own lane starts from: its id
 * VERBATIM when the grammar already admits it, and {@link laneNameFromId}'s
 * escape otherwise.
 *
 * Preferring the id is not cosmetic. A context whose lane is "itself" compiled
 * to its id verbatim before lane names had one owner, so every plan already
 * launched under that rule carries a definition — and a hash an approval binds
 * to — naming these lanes exactly this way. Encoding an id the grammar accepts
 * would re-identify those definitions for nothing: the escape exists to make an
 * ILLEGAL id nameable, not to renormalize a legal one.
 *
 * Unlike `laneNameFromId` this is NOT injective on its own — a legal id can be
 * spelled exactly like some illegal id's escape — so it is only safe inside
 * {@link allocateLaneNames}, whose contested-name pass resolves that overlap the
 * same way it resolves an authored name a generated base wanted. The output
 * satisfies `laneIdViolation` either way: the identity branch is taken only when
 * the grammar already accepted the id.
 */
export function soloLaneBaseFromId(id: string): string {
  return laneIdViolation(id) === null ? id : laneNameFromId(id);
}

/** A context whose lane name its author chose. The name is reserved verbatim. */
export interface AuthoredLaneEntry {
  contextId: string;
  lane: string;
}

/** A context with no authored lane, which is named after its own id. */
export interface GeneratedLaneEntry {
  contextId: string;
}

/**
 * Resolve one lane name per context across the ONE namespace authored and
 * generated names share.
 *
 * A generated base ({@link soloLaneBaseFromId}) can be contested two ways: an
 * authored name may be spelled exactly like it, and — because the base prefers a
 * legal id verbatim over its escape — one context's id may be spelled exactly
 * like another's escape. Either way two contexts would share a lane each
 * believes it owns alone. Allocation is therefore a whole-plan pass in three
 * ordered steps:
 *
 *  1. authored names are reserved verbatim — an author chose theirs, and
 *     nothing outside this allocator ever spells a generated one;
 *  2. every uncontested generated base is claimed, so a rename can never
 *     displace a context that would have been spelled like its own id;
 *  3. the remainder are suffixed from `-2`, skipping names already taken.
 *
 * Both spellings of the session lane are reserved before step 2. The session
 * lane is the session worktree rather than a provisioned group lane, so
 * definition validation refuses either spelling on a context; without the
 * reservation a context named after it would generate a lane that validation
 * then rejects.
 *
 * Every generated name the allocator returns satisfies `laneIdViolation` by
 * construction: the base is legal either way `soloLaneBaseFromId` produced it,
 * and a `-<digits>` suffix closes on a digit. Authored names pass through
 * untouched — the grammar is enforced where the name was authored, not repaired
 * here.
 */
export function allocateLaneNames(
  authored: readonly AuthoredLaneEntry[],
  generated: readonly GeneratedLaneEntry[],
): ReadonlyMap<string, string> {
  const lanes = new Map<string, string>();
  const taken = new Set<string>([SESSION_LANE_NAME, SESSION_LANE_ID]);

  for (const entry of authored) {
    lanes.set(entry.contextId, entry.lane);
    taken.add(entry.lane);
  }

  const contested: { contextId: string; base: string }[] = [];
  for (const { contextId } of generated) {
    const base = soloLaneBaseFromId(contextId);
    if (taken.has(base)) {
      contested.push({ contextId, base });
      continue;
    }
    taken.add(base);
    lanes.set(contextId, base);
  }

  for (const { contextId, base } of contested) {
    let suffix = 2;
    while (taken.has(`${base}-${suffix}`)) suffix += 1;
    taken.add(`${base}-${suffix}`);
    lanes.set(contextId, `${base}-${suffix}`);
  }

  return lanes;
}

/** Backward-compatible alias retained while callers migrate to validateLaneId. */
export function validateContextId(contextId: string): void {
  try {
    validateLaneId(contextId);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(err.message.replace(/laneId/g, "contextId"));
    }
    throw err;
  }
}

/** Lane kinds whose lanes are per-assignment rather than per-context. */
const ASSIGNMENT_SCOPED_LANES: ReadonlySet<GraphWorkflowLaneKind> = new Set([
  "context_validator",
]);

export interface LaneIdentity {
  lane: GraphWorkflowLaneKind;
  /** Null for lane kinds that are not assignment-scoped (the implementer). */
  assignmentId: string | null;
}

function toLaneKind(value: string): GraphWorkflowLaneKind | null {
  const parsed = graphWorkflowLaneKindSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The `laneStates[contextId]` inner key: `implementer` or
 * `context_validator:<assignmentId>`.
 *
 * An assignment id is lowercase kebab-case (see `agentAssignmentIdSchema`), so
 * it can never contain the `:` separator and the encoding is unambiguous.
 */
export function laneStateKey(
  lane: GraphWorkflowLaneKind,
  assignmentId?: string,
): string {
  return assignmentId !== undefined && ASSIGNMENT_SCOPED_LANES.has(lane)
    ? `${lane}${ASSIGNMENT_SEPARATOR}${assignmentId}`
    : lane;
}

export function parseLaneStateKey(key: string): LaneIdentity | null {
  const separatorIndex = key.indexOf(ASSIGNMENT_SEPARATOR);
  if (separatorIndex === -1) {
    const lane = toLaneKind(key);
    return lane === null ? null : { lane, assignmentId: null };
  }
  const lane = toLaneKind(key.slice(0, separatorIndex));
  const assignmentId = key.slice(separatorIndex + 1);
  if (lane === null || assignmentId.length === 0) return null;
  return { lane, assignmentId };
}

/**
 * Primitive-layer lane id for a graph lane. The NUL separator cannot occur in a
 * lane kind, a context id, or an assignment id, so the encoding is unambiguous.
 * The assignment is a third segment rather than a widened second one, so a
 * context id containing any printable character stays parseable.
 */
export function graphLaneId(
  lane: GraphWorkflowLaneKind,
  contextId: string,
  assignmentId?: string,
): string {
  const scoped =
    assignmentId !== undefined && ASSIGNMENT_SCOPED_LANES.has(lane);
  return [lane, contextId, ...(scoped ? [assignmentId] : [])].join(
    LANE_ID_SEPARATOR,
  );
}

export function parseGraphLaneId(
  laneId: string,
): (LaneIdentity & { contextId: string }) | null {
  const segments = laneId.split(LANE_ID_SEPARATOR);
  if (segments.length < 2 || segments.length > 3) return null;
  const [laneSegment, contextId, assignmentSegment] = segments;
  const lane = toLaneKind(laneSegment ?? "");
  if (lane === null || !contextId) return null;
  if (assignmentSegment === undefined) {
    return { lane, contextId, assignmentId: null };
  }
  if (assignmentSegment.length === 0) return null;
  return { lane, contextId, assignmentId: assignmentSegment };
}

/**
 * Assignment fields captured by the lane at creation. Live edits compare these
 * to freeze started assignments, and continuation verifies the stored identity.
 */
export interface FingerprintableAssignment {
  profileSnapshot: { resolvedInstructionHash: string };
  agent: GraphWorkflowAgentConfig;
  strategy?: string;
  authority?: string;
  focus?: string;
}

export function assignmentFingerprint(
  assignment: FingerprintableAssignment,
): string {
  return [
    assignment.profileSnapshot.resolvedInstructionHash,
    assignment.strategy ?? "",
    assignment.authority ?? "",
    assignment.focus ?? "",
    assignment.agent.backend,
    modelSelectionKey(assignment.agent.modelSelection),
  ].join("|");
}
