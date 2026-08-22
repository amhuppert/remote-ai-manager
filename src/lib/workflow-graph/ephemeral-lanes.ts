/**
 * Ephemeral lanes (README §2.2) — an empty lane the author has drawn but no
 * context has landed in yet.
 *
 * The whole module exists to keep one rule true: an empty lane is NOT an
 * authored entity. There is no lane record in the definition — a lane exists
 * exactly because some context's `placement.lane` names it — so an empty band
 * has nowhere to be serialized to, and inventing a place for it would create the
 * lane entity the design refuses. It therefore lives in UI state beside the
 * draft, never inside it, and creating one leaves the definition clean.
 *
 * What is decided here is naming: what a new band is called, and what typing a
 * name into one means. Names go through the SAME grammar
 * (`laneIdViolation`) and the SAME reserved-name rules that authored placements
 * go through, because a band's name becomes a `placement.lane` value the moment
 * a context is dropped into it — validating it any other way would let the band
 * promise a placement the accept-time gate would then refuse.
 */

import type { LaneBand } from "./lane-bands";
import {
  laneIdViolation,
  SESSION_LANE_ID,
  SESSION_LANE_NAME,
} from "./lane-identity";

/** A client-only empty lane. `id` survives renames; `name` is what it is called. */
export interface EphemeralLane {
  readonly id: string;
  readonly name: string;
}

interface EphemeralLaneDefinition {
  readonly executionContexts: readonly {
    readonly placement?: { readonly lane: string };
  }[];
}

const DEFAULT_LANE_NAME = "new-lane";

/**
 * Every lane name the draft already spells for itself, in display form.
 *
 * `__session__` folds to `session` because a band shows the authored spelling,
 * and a new band called `session` has to collide with the session lane however
 * the draft happens to spell it.
 */
export function definitionLaneNames(
  definition: EphemeralLaneDefinition | null | undefined,
): string[] {
  const names = new Set<string>();
  for (const context of definition?.executionContexts ?? []) {
    const lane = context.placement?.lane;
    if (lane === undefined) continue;
    names.add(lane === SESSION_LANE_ID ? SESSION_LANE_NAME : lane);
  }
  return [...names];
}

/**
 * The name a freshly drawn band takes. It is a legal, unused lane name rather
 * than an empty one so the band is a valid drop target from the first frame —
 * an author who drags a context into it before typing anything gets the same
 * accepted placement as one who names it first.
 */
export function defaultEphemeralLaneName(taken: readonly string[]): string {
  const used = new Set(taken);
  if (!used.has(DEFAULT_LANE_NAME)) return DEFAULT_LANE_NAME;
  let suffix = 2;
  while (used.has(`${DEFAULT_LANE_NAME}-${suffix}`)) suffix += 1;
  return `${DEFAULT_LANE_NAME}-${suffix}`;
}

export type EphemeralLaneNameResolution =
  /** The name is the band's own: nothing to do. */
  | { readonly outcome: "unchanged"; readonly laneName: string }
  | { readonly outcome: "renamed"; readonly laneName: string }
  /**
   * The name belongs to a lane that already exists, so it means "use that
   * lane". The band is removed rather than duplicated.
   */
  | {
      readonly outcome: "merged";
      readonly laneName: string;
      readonly notice: string;
    }
  | { readonly outcome: "refused"; readonly message: string };

export interface EphemeralLaneNameInput {
  readonly name: string;
  /** The band being named, so its own name is not read as a collision. */
  readonly currentName: string;
  /** Every other lane name on the canvas — authored and ephemeral alike. */
  readonly taken: readonly string[];
}

/**
 * What typing `name` into a band means.
 *
 * The reserved session spellings are refused ahead of the grammar check because
 * both satisfy it: `session` and `__session__` are legal branch segments and are
 * rejected for what they DENOTE, not for how they are spelled.
 */
export function resolveEphemeralLaneName(
  input: EphemeralLaneNameInput,
): EphemeralLaneNameResolution {
  const name = input.name.trim();

  if (name.length === 0) {
    return {
      outcome: "refused",
      message: "A lane needs a name before a context can be placed on it.",
    };
  }
  if (name === input.currentName) {
    return { outcome: "unchanged", laneName: name };
  }
  if (name === SESSION_LANE_NAME) {
    return {
      outcome: "refused",
      message: `"${SESSION_LANE_NAME}" is the session worktree, not a group lane — it admits read-only contexts only and is never provisioned.`,
    };
  }
  if (name === SESSION_LANE_ID) {
    return {
      outcome: "refused",
      message: `"${SESSION_LANE_ID}" is the engine's internal id for the session lane, never an authored lane name.`,
    };
  }

  const violation = laneIdViolation(name);
  if (violation !== null) {
    return {
      outcome: "refused",
      message: `Lane names become branch and worktree path segments: it ${violation}.`,
    };
  }

  if (input.taken.includes(name)) {
    return {
      outcome: "merged",
      laneName: name,
      notice: `Naming it ${name} means "use the existing lane" — the band merges with it rather than creating a duplicate.`,
    };
  }

  return { outcome: "renamed", laneName: name };
}

/**
 * The band shape an ephemeral lane renders and is hit-tested as. It is a
 * `LaneBand` with no members, which is precisely what it is: a lane has no
 * grade, so an empty one has nothing to summarize.
 */
/**
 * The canvas's bands, empty ones included. Rendering and drag hit-testing both
 * go through this so a band an author can see is always a band a drop can
 * reach — the two cannot disagree about what is on the canvas.
 */
export function withEphemeralLaneBands(
  bands: readonly LaneBand[],
  lanes: readonly EphemeralLane[],
): LaneBand[] {
  return [...bands, ...lanes.map(ephemeralLaneBand)];
}

export function ephemeralLaneBand(lane: EphemeralLane): LaneBand {
  return {
    laneName: lane.name,
    state: "pending",
    reserved: false,
    memberContextIds: [],
    memberCount: 0,
    membershipLabel: "0 members",
    gradeSummary: "",
    runtime: null,
  };
}
