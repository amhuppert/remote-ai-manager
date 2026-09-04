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
import { graphWorkflowSeededDocuments } from "./0023-graph-workflow-seeded-documents";
import { collabLaneFlowAgentIds } from "./0024-collab-lane-flow-agent-ids";
import { executionLeaseAndResultDeliveries } from "./0024-execution-lease-and-result-deliveries";
import { graphWorkflowPendingArtifacts } from "./0025-graph-workflow-pending-artifacts";
import { deliveryPlanLaunchCutover } from "./0026-delivery-plan-launch-cutover";
import { retireReleaseSlotCleanupPhase } from "./0026-retire-release-slot-cleanup-phase";
import { workflowResultNotifications } from "./0027-workflow-result-notifications";
import { retireDeliveryPlanAmendments } from "./0027-retire-delivery-plan-amendments";
import { retireLegacySpecExecutions } from "./0028-retire-legacy-spec-executions";
import { workflowResultEffectReceipts } from "./0028-workflow-result-effect-receipts";
import { addSpecDeliveryVerdicts } from "./0029-add-spec-delivery-verdicts";
import { jobRecordParkedMerge } from "./0029-job-record-parked-merge";
import { nativeSddV2Cutover } from "./0030-native-sdd-v2-cutover";
import { graphWorkflowCandidateUnstableHalt } from "./0031-graph-workflow-candidate-unstable-halt";
import { addGraphPlanReviews } from "./0032-add-graph-plan-reviews";
import { conversationOwnership } from "./0033-conversation-ownership";
import { nativeSddAttentionCitations } from "./0034-native-sdd-attention-citations";
import { addNotepads } from "./0035-add-notepads";
import { generalizedModelSelection } from "./0035-generalized-model-selection";
import { addNotepadComments } from "./0036-add-notepad-comments";
import { addNotepadDeliveryWatermarks } from "./0037-add-notepad-delivery-watermarks";
import { ticketRelationshipsAndStatusUpdates } from "./0038-ticket-relationships-and-status-updates";
import { nativeSddManagedWorkflowDefinitions } from "./0039-native-sdd-managed-workflow-definitions";
import { addMemoryNotes } from "./0040-add-memory-notes";
import { addMemorySearchIndex } from "./0041-add-memory-search-index";
import { addMemoryTelemetry } from "./0042-add-memory-telemetry";

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
  graphWorkflowSeededDocuments,
  collabLaneFlowAgentIds,
  executionLeaseAndResultDeliveries,
  graphWorkflowPendingArtifacts,
  deliveryPlanLaunchCutover,
  retireReleaseSlotCleanupPhase,
  workflowResultNotifications,
  retireDeliveryPlanAmendments,
  retireLegacySpecExecutions,
  workflowResultEffectReceipts,
  addSpecDeliveryVerdicts,
  jobRecordParkedMerge,
  // Last by construction: the native-SDD v2 cutover is the destructive
  // barrier that stamps schema version 9, so every additive migration
  // applies before the version flips.
  nativeSddV2Cutover,
  graphWorkflowCandidateUnstableHalt,
  addGraphPlanReviews,
  conversationOwnership,
  nativeSddAttentionCitations,
  // Additive before the version flip: the notepad tables are purely additive
  // and stamp no schema version, so they apply ahead of the model-selection
  // cutover that does.
  addNotepads,
  generalizedModelSelection,
  // Additive too, and ordered after the cutover only so the ledger key stays
  // lexicographically in step with the array.
  addNotepadComments,
  addNotepadDeliveryWatermarks,
  ticketRelationshipsAndStatusUpdates,
  nativeSddManagedWorkflowDefinitions,
  addMemoryNotes,
  addMemorySearchIndex,
  addMemoryTelemetry,
];

export type { MigrationContext, StateMigration } from "./types";
