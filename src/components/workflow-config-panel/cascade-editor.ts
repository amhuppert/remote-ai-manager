import type { ValidationCommandSummary } from "@/lib/validation/schemas";
import type { ConfigCascade, ConfigEditIntent } from "./config-cascade";
import type { ConfigAffordance, ConfigPanelHost } from "./types";

/**
 * What a cascading configuration screen needs from the page that mounted the
 * panel — the counterpart of `ContextStructuralEditor` for the blocks that
 * inherit.
 *
 * A screen never holds the draft. It reads the resolved value and its
 * provenance off the cascade, and emits one intent per edit; the host applies
 * that intent with `applyConfigEditToWorkflowConfig` / `applyConfigEditToContext`
 * and hands back a fresh cascade. That is what keeps the three granularities
 * honest across two hosts: promoting one collaboration field or one validation
 * role cannot take its siblings with it, because the screen never writes the
 * block it belongs to.
 */
export interface ConfigCascadeEditor {
  host: ConfigPanelHost;
  /**
   * What the run's state permits. Screens derive "is everything disabled" from
   * it through `isConfigLocked`; the builder always passes `editable`.
   */
  affordance: ConfigAffordance;
  /** Started assignment lanes, keyed by the canonical laneStateKey encoding. */
  startedLaneKeys?: ReadonlySet<string>;
  cascade: ConfigCascade;
  onEdit: (intent: ConfigEditIntent) => void;
  /**
   * The project's registered validation commands, from the live registry query
   * (`useValidationCommandOptions`). `undefined` means the registry is
   * UNAVAILABLE, never that it is empty — the command screens say so rather
   * than presenting an empty checklist as a project with no commands.
   */
  validationCommands: readonly ValidationCommandSummary[] | undefined;
  /**
   * Scopes the agent-profile listing. `null` for a surface belonging to no
   * project, which lists the tiers outside every project.
   */
  libraryProjectName?: string | null;
  /**
   * Re-run ONE cohort member against the current candidate in its conversation
   * (README §11), without discarding the sibling verdicts a whole-context reset
   * would take with it. Execution host only, and absent unless the run is in a
   * state the reducer will accept a reset in — offering it otherwise would
   * promise an action the endpoint refuses.
   */
  onResetSeat?: (seatId: string) => void;
  /** The seat whose reset is in flight, if any. */
  resettingSeatId?: string | null;
}
