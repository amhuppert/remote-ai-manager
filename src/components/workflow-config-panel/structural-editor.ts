import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  ParameterDeclaration,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/context-outputs";
import type { ConfigAffordance, ConfigPanelHost } from "./types";

/**
 * What a structural screen needs from the page that mounted the panel.
 *
 * Every edit is a whole-value callback rather than a field patch: the hosts own
 * the draft (the builder store, the live working definition), so the panel
 * hands back a complete replacement and the host's existing dirty tracking sees
 * one ordinary write. It is also what keeps unauthored fields intact — a screen
 * spreads the value it was given, so `mutability.allowAgentContextAdd` and
 * every other field no screen exposes round-trips verbatim (README §6).
 */

/**
 * Where a live context is running. Read-only, execution host only (§11), which
 * lands the whole runtime set here: lane, branch, worktree, activity, merge and
 * cleanup. Every field is a string so the screen renders one uniform row shape;
 * an empty one reads as "—", and `mergeError` is the single row that stays away
 * entirely until there is an error to report.
 */
export interface ContextRuntimeFacts {
  lane: string;
  branch: string;
  worktree: string;
  isolation: string;
  activity: string;
  merge: string;
  cleanup: string;
  join: string;
  batch: string;
  mergeError: string;
}

export interface ContextStructuralEditor {
  host: ConfigPanelHost;
  /**
   * What the run's state permits. Screens derive "is everything disabled" from
   * it through `isConfigLocked` rather than carrying a second boolean, because
   * the output-schema editor needs the exact mode to say WHY it is disabled
   * (README §8.1) — and two fields could disagree. The builder always passes
   * `editable`: it edits a saved template, which no execution state can lock.
   */
  affordance: ConfigAffordance;
  context: GraphWorkflowExecutionContextDefinition;
  onContextChange: (next: GraphWorkflowExecutionContextDefinition) => void;
  /**
   * The output schema as RAW TEXT, never a parsed object: a half-typed
   * declaration has to survive a re-render, and the last valid parse must not
   * be what a save persists under fresh red text (README §6).
   */
  outputSchemaText: string;
  onOutputSchemaTextChange: (next: string) => void;
  /**
   * Output was already captured against this contract, so the declaration is
   * settled INDEPENDENTLY of the mode (README §8.1): a paused execution is
   * otherwise fully editable, and moving the contract under a banked payload
   * would not re-validate it. Execution host only; the builder edits a template
   * that has captured nothing.
   */
  schemaFrozen?: boolean;
  /** Resolver-fed and read-only; the panel never walks edges itself. */
  upstreamInputs: readonly GraphWorkflowUpstreamInput[];
  /** This context's tasks, in order. */
  tasks: readonly GraphWorkflowTaskDefinition[];
  /**
   * Every task id in the WHOLE workflow, this context's included. Task ids are
   * validated for uniqueness across the definition rather than within a context
   * (`duplicate-task-id`), so the Add-task allocator has to see its siblings'
   * ids or it will mint a duplicate that only surfaces when Save is refused.
   * Hosts pass `definition.tasks.map((task) => task.id)`.
   */
  workflowTaskIds: readonly string[];
  onTasksChange: (next: GraphWorkflowTaskDefinition[]) => void;
  /**
   * Submit the draft straight from a prose editor's own shortcut, optionally
   * carrying a context value the host has not observed yet — a stop-and-submit
   * dictation delivers its text and its save in one act, so waiting for the
   * change handler's state to settle would diff without it.
   */
  onRequestSave?: (
    nextContext?: GraphWorkflowExecutionContextDefinition,
  ) => void;
  /** Builder host only — the execution host has no draft to delete from. */
  onDeleteContext?: () => void;
  /** Execution host only; absent on the builder, where nothing is running. */
  runtime?: ContextRuntimeFacts;
}

export interface WorkflowStructuralEditor {
  /** Workflow scope exists on the builder only, so this is always `editable`
   * today; carried for the same single-source reason as the context editor. */
  affordance: ConfigAffordance;
  charter: WorkflowCharter;
  onCharterChange: (next: WorkflowCharter) => void;
  parameters: readonly ParameterDeclaration[];
  onParametersChange: (next: ParameterDeclaration[]) => void;
  /** The contexts a charter entry may be scoped to, in canvas order. */
  contexts: readonly { id: string; title: string }[];
}
