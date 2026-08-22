import type { WorkflowAdvisoryIdentity } from "@/lib/workflow-graph/definition-schemas";

/**
 * The inspector's navigation vocabulary.
 *
 * One name for each destination another surface can send a reader to, so a
 * deep link (an output-schema halt's *Edit schema*, an advisory's origin) is a
 * typed request rather than a string every caller re-spells. §11's footer names
 * the semantics preserved here: context → Inspector, output-schema halt →
 * Context Config, advisory origin → Context History at the round that raised it.
 *
 * Routing lives in the two pure functions below rather than in the rail: a
 * request has to survive selecting the context, and the reader must stay put
 * once they navigate away from where a request put them.
 */

export type InspectorTab = "tasks" | "config" | "history";

export interface InspectorDestination {
  tab: InspectorTab;
  /**
   * Config tab only: a screen path inside the context config panel, in the
   * vocabulary `createPanelNavigationState` already understands.
   */
  screen?: readonly string[];
  /**
   * History tab only: the advisory to anchor on, by its own identity rather
   * than by the round number it carries.
   *
   * An indexed advisory outlives its round — by the time it is read the context
   * is usually several rounds further on — so the tab alone lands in the wrong
   * place. The number alone is no better: a context reset restarts the
   * numbering, and the record carries no attempt identity, so a link naming
   * round 1 cannot say WHICH round 1 it means. The identity can: the round that
   * holds this advisory is the round that raised it, and a round that does not
   * hold it is not that round however it is numbered.
   */
  advisory?: WorkflowAdvisoryIdentity;
}

export interface InspectorNavigationRequest extends InspectorDestination {
  contextId: string;
  /**
   * Distinguishes a repeat request from a re-render of the previous one, so
   * clicking the same deep link twice re-opens the destination.
   */
  seq: number;
}

/** What another surface may ask the inspector to do. */
export interface InspectorNavigationHandle {
  openContext(contextId: string, destination: InspectorDestination): void;
}

/** Halt card → *Edit schema* → Config tab → Brief → Output schema. */
export const OUTPUT_SCHEMA_REPAIR: InspectorDestination = {
  tab: "config",
  screen: ["brief", "schema"],
};

/**
 * Gates list → the context that holds the gate.
 *
 * Tasks rather than a gate-specific screen: both the approval surface and the
 * answering surface sit above the context's tabs, and Tasks is where a reader
 * deciding on a candidate needs to be — the tasks it covers and their history.
 */
export const GATE_CONTEXT: InspectorDestination = { tab: "tasks" };

/**
 * Join card → *Open lane worktree* → Config tab → Placement.
 *
 * The same screen `PLACEMENT_OWNERSHIP` names, because the config panel carries
 * the lane's runtime facts — lane, branch, worktree, isolation, merge and join
 * state — on Placement beside the owned-path editor. The two remain separate
 * destinations: the join card offers separate acts, and what a reader is sent
 * to read there differs even when the screen holding both does not.
 */
export const LANE_RUNTIME: InspectorDestination = {
  tab: "config",
  screen: ["placement"],
};

/** Join card → *Edit ownership* → Config tab → Placement. */
export const PLACEMENT_OWNERSHIP: InspectorDestination = {
  tab: "config",
  screen: ["placement"],
};

/** Advisory → History tab, anchored on the round that raised it. */
export function ADVISORY_ORIGIN(
  advisory: WorkflowAdvisoryIdentity,
): InspectorDestination {
  return { tab: "history", advisory };
}

export function nextNavigationRequest(
  previous: InspectorNavigationRequest | null,
  contextId: string,
  destination: InspectorDestination,
): InspectorNavigationRequest {
  return {
    ...destination,
    contextId,
    seq: (previous?.seq ?? 0) + 1,
  };
}

/**
 * The destination a context should open at, or `null` when the request is not
 * for it or has already been honoured.
 */
export function resolveNavigationRequest(
  request: InspectorNavigationRequest | null,
  contextId: string,
  honouredSeq: number | null,
): InspectorDestination | null {
  if (request === null) return null;
  if (request.contextId !== contextId) return null;
  if (honouredSeq === request.seq) return null;

  return {
    tab: request.tab,
    ...(request.screen === undefined ? {} : { screen: request.screen }),
    ...(request.advisory === undefined ? {} : { advisory: request.advisory }),
  };
}
