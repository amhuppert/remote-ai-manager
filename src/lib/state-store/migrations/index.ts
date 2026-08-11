import type { StateMigration } from "./types";
import { dropLegacyRoadmapItems } from "./0001-drop-legacy-roadmap-items";
import { splitGraphWorkflowHistory } from "./0002-split-graph-workflow-history";
import { splitGraphWorkflowExecution } from "./0003-split-graph-workflow-execution";
import { fastToNormal } from "./0004-fast-to-normal";
import { agentSessionRefShape } from "./0005-agent-session-ref-shape";
import { codexRunsToAgentRuns } from "./0006-codex-runs-to-agent-runs";
import { moveMachineSnapshotsToSidecar } from "./0007-move-machine-snapshots-to-sidecar";
import { addSpecAuthoringStage } from "./0008-add-spec-authoring-stage";
import { narrowEvidenceKinds } from "./0009-narrow-evidence-kinds";
import { freezeSpecExecutionLaunch } from "./0010-freeze-spec-execution-launch";
import { addValidationRuns } from "./0011-add-validation-runs";
import { workflowAgentAssignments } from "./0011-workflow-agent-assignments";
import { validationCostExceedsLimitStatus } from "./0012-validation-cost-exceeds-limit-status";
import { scriptValidatorCommands } from "./0013-script-validator-commands";
import { validationRunSessionName } from "./0014-validation-run-session-name";
import { addDeliveryPlanAttempts } from "./0015-add-delivery-plan-attempts";
import { mintGraphWorkflowEdgeIds } from "./0015-mint-graph-workflow-edge-ids";
import { addDeliveryPlanCandidates } from "./0016-add-delivery-plan-candidates";
import { graphWorkflowContextPlacement } from "./0016-graph-workflow-context-placement";
import { validationRunScopes } from "./0016-validation-run-scopes";
import { specExecutionAbandonCoordinator } from "./0017-spec-execution-abandon-coordinator";
import { deliveryPlanPrelaunch } from "./0018-delivery-plan-prelaunch";
import { deliveryPlanApprovalIdentity } from "./0019-delivery-plan-approval-identity";
import { addDeliveryDiscoveries } from "./0020-add-delivery-discoveries";
import { deliveryPlanComments } from "./0020-delivery-plan-comments";
import { specRevisionExternalDelivery } from "./0021-spec-revision-external-delivery";
import { importGateAdmissionBasis } from "./0022-import-gate-admission-basis";

/**
 * Ordered registry of state-store migrations. Append new migrations here in
 * sequence; each must be idempotent and named with a zero-padded numeric prefix
 * so lexicographic ordering matches intended run order. See `migrator.ts` for
 * the runner and `README.md` in this directory for the authoring recipe.
 */
export const migrations: readonly StateMigration[] = [
  dropLegacyRoadmapItems,
  splitGraphWorkflowHistory,
  splitGraphWorkflowExecution,
  fastToNormal,
  agentSessionRefShape,
  codexRunsToAgentRuns,
  moveMachineSnapshotsToSidecar,
  addSpecAuthoringStage,
  narrowEvidenceKinds,
  freezeSpecExecutionLaunch,
  addValidationRuns,
  workflowAgentAssignments,
  validationCostExceedsLimitStatus,
  scriptValidatorCommands,
  validationRunSessionName,
  addDeliveryPlanAttempts,
  mintGraphWorkflowEdgeIds,
  addDeliveryPlanCandidates,
  graphWorkflowContextPlacement,
  validationRunScopes,
  specExecutionAbandonCoordinator,
  deliveryPlanPrelaunch,
  deliveryPlanApprovalIdentity,
  addDeliveryDiscoveries,
  deliveryPlanComments,
  specRevisionExternalDelivery,
  importGateAdmissionBasis,
];

export type { MigrationContext, StateMigration } from "./types";
