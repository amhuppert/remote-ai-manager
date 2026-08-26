import { createLogger } from "@/lib/logging";
import {
  validateWorkflowPlan,
  type WorkflowPlanCommandIssue,
  type WorkflowPlanIssue,
} from "@/lib/workflows/plan-validation";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import type { AgentBackendsConfig } from "@/lib/config/schemas";
import type { BackendModelCatalogFacet } from "@/lib/agent-backends/descriptor";
import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import {
  VALIDATION_COST_EXCEEDS_LIMIT_CODE,
  createValidationCommandPreflight,
  type ValidationCommandPreflight,
} from "@/lib/validation/preflight";
import type {
  GlobalValidationConfig,
  RepoValidationConfig,
} from "@/lib/validation/schemas";
import type { WorkflowDefinitionDraft } from "./storage";
import {
  createAssignmentReferenceChecker,
  type AssignmentDocumentScope,
  type AssignmentReferenceChecker,
  WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE,
} from "./assignment-references";
import {
  AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS,
  type AuthoredWorkflowLaunchAdmissionCaller,
} from "./authored-launch-admission-callers";
import { collectStableAccountabilityContextIds } from "./authored-accountability";
import {
  locateAuthoredAccountabilityCoverage,
  type AuthoredAccountabilityCoverageGroup,
  type LocatedAuthoredAccountabilityCoverage,
} from "./authored-accountability-coverage";
import {
  admitAuthoredWorkflowModelSelections,
  WORKFLOW_MODEL_SELECTION_INVALID_CODE,
} from "./model-selection-admission";

export {
  admitAuthoredWorkflowModelSelections,
  type AuthoredWorkflowModelSelectionAdmissionResult,
} from "./model-selection-admission";

const logger = createLogger("workflow-graph-admission");

export type AuthoredWorkflowLaunchAdmissionResult =
  | {
      ok: true;
      launch: WorkflowDefinitionDraft;
      warnings: WorkflowPlanIssue[];
      stableAccountabilityContextIds: string[];
      accountabilityGroupAnalysis: LocatedAuthoredAccountabilityCoverage[];
    }
  | {
      ok: false;
      issues: WorkflowPlanIssue[];
      commandIssues?: WorkflowPlanCommandIssue[];
      code?:
        | typeof VALIDATION_COST_EXCEEDS_LIMIT_CODE
        | typeof WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE
        | typeof WORKFLOW_MODEL_SELECTION_INVALID_CODE;
    };
type AuthoredWorkflowLaunchAdmissionRejection = Extract<
  AuthoredWorkflowLaunchAdmissionResult,
  { ok: false }
>;

export interface AuthoredWorkflowLaunchAdmissionDeps {
  caller: AuthoredWorkflowLaunchAdmissionCaller;
  documentScope: AssignmentDocumentScope;
  projectValidation?: RepoValidationConfig | null;
  globalValidation?: GlobalValidationConfig;
  workflowDefaults: Partial<WorkflowDefaults> | undefined;
  agentBackends: AgentBackendsConfig;
  modelCatalogFor?(
    backend: keyof AgentBackendsConfig,
  ): BackendModelCatalogFacet;
  assignmentReferences?: AssignmentReferenceChecker;
  accountabilityGroups?: readonly AuthoredAccountabilityCoverageGroup[];
}

export function authoredLaunchWarningFields(
  warnings: readonly WorkflowPlanIssue[],
): { warnings?: WorkflowPlanIssue[] } {
  return warnings.length === 0 ? {} : { warnings: [...warnings] };
}

function rejected(
  caller: AuthoredWorkflowLaunchAdmissionCaller,
  documentScope: AssignmentDocumentScope,
  issues: readonly WorkflowPlanIssue[],
  code?: AuthoredWorkflowLaunchAdmissionRejection["code"],
  warningCount = 0,
  commandIssues?: readonly WorkflowPlanCommandIssue[],
): AuthoredWorkflowLaunchAdmissionRejection {
  logger.warn("workflow-graph.authored-launch-admission.rejected", {
    caller,
    documentScope: documentScope.kind,
    sourceResolutionKind: "root-independent",
    issueCount: issues.length,
    warningCount,
    ...(code === undefined ? {} : { code }),
  });
  return {
    ok: false,
    issues: [...issues],
    ...(commandIssues === undefined
      ? {}
      : { commandIssues: [...commandIssues] }),
    ...(code === undefined ? {} : { code }),
  };
}

export async function admitAuthoredWorkflowLaunch(
  rawLaunch: unknown,
  deps: AuthoredWorkflowLaunchAdmissionDeps,
): Promise<AuthoredWorkflowLaunchAdmissionResult> {
  const registration = AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS[deps.caller];
  if (!registration) {
    throw new Error(
      `Unregistered authored-launch admission caller: ${deps.caller}`,
    );
  }
  const permittedDocumentScopes =
    registration.documentScopes as readonly AssignmentDocumentScope["kind"][];
  if (!permittedDocumentScopes.includes(deps.documentScope.kind)) {
    throw new Error(
      `Authored-launch admission caller ${deps.caller} cannot admit ${deps.documentScope.kind}-scope documents`,
    );
  }
  const validationCommandPreflight: ValidationCommandPreflight | undefined =
    deps.projectValidation === undefined
      ? undefined
      : createValidationCommandPreflight(
          deps.projectValidation ?? undefined,
          deps.globalValidation,
        );
  const parsed = validateWorkflowPlan(rawLaunch, {
    validationCommandPreflight,
  });
  if (!parsed.ok) {
    return rejected(
      deps.caller,
      deps.documentScope,
      parsed.issues,
      parsed.code,
      0,
      parsed.commandIssues,
    );
  }

  const modelSelectionAdmission = await admitAuthoredWorkflowModelSelections(
    parsed.draft,
    {
      agentBackends: deps.agentBackends,
      ...(deps.documentScope.kind === "project"
        ? { projectPath: deps.documentScope.projectPath }
        : {}),
      modelCatalogFor:
        deps.modelCatalogFor ??
        ((backend) => getBackendDescriptor(backend).modelCatalog),
    },
  );
  if (!modelSelectionAdmission.ok) {
    return rejected(
      deps.caller,
      deps.documentScope,
      modelSelectionAdmission.issues,
      WORKFLOW_MODEL_SELECTION_INVALID_CODE,
      parsed.warnings.length,
    );
  }
  const launch = modelSelectionAdmission.launch;

  const assignmentReferences =
    deps.assignmentReferences ?? createAssignmentReferenceChecker();
  const issues = [
    ...(await assignmentReferences.checkDefinition(
      launch.definition,
      deps.documentScope,
      "definition",
    )),
    ...(await assignmentReferences.checkWorkflowDefaults(
      deps.workflowDefaults,
      "workflowDefaults",
    )),
  ];
  if (issues.length > 0) {
    return rejected(
      deps.caller,
      deps.documentScope,
      issues,
      WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE,
      parsed.warnings.length,
    );
  }

  const stableAccountabilityContextIds = collectStableAccountabilityContextIds(
    launch.definition,
  );
  const accountabilityGroupAnalysis = locateAuthoredAccountabilityCoverage({
    source: { kind: "authored", definition: launch.definition },
    groups: deps.accountabilityGroups ?? [],
  });
  logger.info("workflow-graph.authored-launch-admission.accepted", {
    caller: deps.caller,
    documentScope: deps.documentScope.kind,
    sourceResolutionKind: "root-independent",
    issueCount: 0,
    warningCount: parsed.warnings.length,
    stableAccountabilityContextCount: stableAccountabilityContextIds.length,
    accountabilityGroupCount: accountabilityGroupAnalysis.length,
    coveredAccountabilityGroupCount: accountabilityGroupAnalysis.filter(
      (group) => group.covered,
    ).length,
  });
  return {
    ok: true,
    launch,
    warnings: parsed.warnings,
    stableAccountabilityContextIds,
    accountabilityGroupAnalysis,
  };
}
