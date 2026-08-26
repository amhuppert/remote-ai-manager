import type { BackendModelCatalogFacet } from "@/lib/agent-backends/descriptor";
import {
  validateModelSelection,
  type ModelSelectionValidationIssue,
} from "@/lib/agent-backends/model-selection";
import type {
  BackendModelCatalog,
  BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import type { AgentBackendsConfig } from "@/lib/config/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { GraphWorkflowAgentConfig } from "./config-schemas";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowDefinitionDraft,
  WorkflowSemanticDefinition,
} from "./definition-schemas";

export const WORKFLOW_MODEL_SELECTION_INVALID_CODE =
  "workflow_model_selection_invalid" as const;

export type WorkflowModelSelectionRole =
  | "implementer"
  | "validator"
  | "plan-repair"
  | "collaboration";

export interface WorkflowModelSelectionSite {
  backend: GraphWorkflowAgentConfig["backend"];
  modelSelection: BackendModelSelection;
  path: string;
  role: WorkflowModelSelectionRole;
  contextId?: string;
  assignmentId?: string;
}

export interface WorkflowModelSelectionIssue {
  path: string;
  message: string;
  code: string;
  modelId: string;
  parameterId?: string;
}

interface MutableWorkflowModelSelectionSite extends WorkflowModelSelectionSite {
  replace(selection: BackendModelSelection): void;
}

interface AgentHolder {
  backend: GraphWorkflowAgentConfig["backend"];
  modelSelection: BackendModelSelection;
}

interface AssignmentHolder {
  id: string;
  agent: AgentHolder;
}

interface ValidatorCohortHolder {
  assignments: readonly AssignmentHolder[];
}

interface PlanRepairHolder {
  agent?: AgentHolder;
}

interface AuthoredCollaborationHolder {
  secondAgent?: AgentHolder;
}

interface ResolvedCollaborationHolder {
  secondAgent?: { value: AgentHolder };
}

function pushAgent(
  sites: MutableWorkflowModelSelectionSite[],
  agent: AgentHolder | undefined,
  input: {
    path: string;
    role: WorkflowModelSelectionRole;
    contextId?: string;
    assignmentId?: string;
  },
): void {
  if (agent === undefined) return;
  sites.push({
    backend: agent.backend,
    modelSelection: agent.modelSelection,
    ...input,
    replace(selection) {
      agent.modelSelection = selection;
    },
  });
}

function pushAssignment(
  sites: MutableWorkflowModelSelectionSite[],
  assignment: AssignmentHolder | undefined,
  path: string,
  role: "implementer" | "validator",
  contextId?: string,
): void {
  if (assignment === undefined) return;
  pushAgent(sites, assignment.agent, {
    path: `${path}.agent.modelSelection`,
    role,
    ...(contextId === undefined ? {} : { contextId }),
    assignmentId: assignment.id,
  });
}

function pushCohort(
  sites: MutableWorkflowModelSelectionSite[],
  cohort: ValidatorCohortHolder | undefined,
  path: string,
  contextId?: string,
): void {
  cohort?.assignments.forEach((assignment, assignmentIndex) => {
    pushAssignment(
      sites,
      assignment,
      `${path}.assignments.${assignmentIndex}`,
      "validator",
      contextId,
    );
  });
}

function pushPlanRepair(
  sites: MutableWorkflowModelSelectionSite[],
  planRepair: PlanRepairHolder | undefined,
  path: string,
  contextId?: string,
): void {
  pushAgent(sites, planRepair?.agent, {
    path: `${path}.agent.modelSelection`,
    role: "plan-repair",
    ...(contextId === undefined ? {} : { contextId }),
  });
}

function pushAuthoredCollaboration(
  sites: MutableWorkflowModelSelectionSite[],
  collaboration: AuthoredCollaborationHolder | undefined,
  path: string,
  contextId?: string,
): void {
  pushAgent(sites, collaboration?.secondAgent, {
    path: `${path}.secondAgent.modelSelection`,
    role: "collaboration",
    ...(contextId === undefined ? {} : { contextId }),
  });
}

function pushResolvedCollaboration(
  sites: MutableWorkflowModelSelectionSite[],
  collaboration: ResolvedCollaborationHolder | undefined,
  path: string,
  contextId?: string,
): void {
  pushAgent(sites, collaboration?.secondAgent?.value, {
    path: `${path}.secondAgent.value.modelSelection`,
    role: "collaboration",
    ...(contextId === undefined ? {} : { contextId }),
  });
}

function mutableAuthoredSites(
  definition: WorkflowSemanticDefinition,
): MutableWorkflowModelSelectionSite[] {
  const sites: MutableWorkflowModelSelectionSite[] = [];
  const workflowConfig = definition.workflowConfig;
  pushAssignment(
    sites,
    workflowConfig.implementer,
    "definition.workflowConfig.implementer",
    "implementer",
  );
  pushCohort(
    sites,
    workflowConfig.contextValidator,
    "definition.workflowConfig.contextValidator",
  );
  pushPlanRepair(
    sites,
    workflowConfig.planRepair,
    "definition.workflowConfig.planRepair",
  );
  pushAuthoredCollaboration(
    sites,
    workflowConfig.collaboration,
    "definition.workflowConfig.collaboration",
  );

  definition.executionContexts.forEach((context, contextIndex) => {
    const prefix = `definition.executionContexts.${contextIndex}`;
    pushAssignment(
      sites,
      context.implementer,
      `${prefix}.implementer`,
      "implementer",
      context.id,
    );
    pushCohort(
      sites,
      context.contextValidator,
      `${prefix}.contextValidator`,
      context.id,
    );
    pushPlanRepair(
      sites,
      context.planRepair,
      `${prefix}.planRepair`,
      context.id,
    );
    pushAuthoredCollaboration(
      sites,
      context.collaboration,
      `${prefix}.collaboration`,
      context.id,
    );
  });

  return sites;
}

function pushResolvedContext(
  sites: MutableWorkflowModelSelectionSite[],
  context: ResolvedWorkflowSemanticDefinition["executionContexts"][number],
  prefix: string,
): void {
  pushAssignment(
    sites,
    context.implementer,
    `${prefix}.implementer`,
    "implementer",
    context.id,
  );
  pushCohort(
    sites,
    context.contextValidator,
    `${prefix}.contextValidator`,
    context.id,
  );
  pushPlanRepair(sites, context.planRepair, `${prefix}.planRepair`, context.id);
  pushResolvedCollaboration(
    sites,
    context.collaboration,
    `${prefix}.collaboration`,
    context.id,
  );
}

export function collectResolvedWorkflowModelSelectionSites(
  definition: ResolvedWorkflowSemanticDefinition,
): WorkflowModelSelectionSite[] {
  const sites: MutableWorkflowModelSelectionSite[] = [];
  definition.executionContexts.forEach((context, contextIndex) => {
    pushResolvedContext(sites, context, `executionContexts.${contextIndex}`);
  });
  definition.loopGroups?.forEach((loopGroup, loopIndex) => {
    const loopPrefix = `loopGroups.${loopIndex}`;
    pushPlanRepair(sites, loopGroup.planRepair, `${loopPrefix}.planRepair`);
    loopGroup.template.contexts.forEach((context, contextIndex) => {
      pushResolvedContext(
        sites,
        context,
        `${loopPrefix}.template.contexts.${contextIndex}`,
      );
    });
  });
  return sites.map(({ replace: _replace, ...site }) => site);
}

function issuePath(
  sitePath: string,
  issue: ModelSelectionValidationIssue,
): string {
  if (issue.parameterId !== undefined) {
    return `${sitePath}.parameters.${issue.parameterId}`;
  }
  if (issue.code === "unknown_model" || issue.code === "model_not_allowed") {
    return `${sitePath}.modelId`;
  }
  return sitePath;
}

function locatedIssue(
  site: WorkflowModelSelectionSite,
  issue: ModelSelectionValidationIssue,
): WorkflowModelSelectionIssue {
  return {
    path: issuePath(site.path, issue),
    message: `${site.role} ${site.backend} model selection is invalid: ${issue.message}`,
    code: issue.code,
    modelId: issue.modelId,
    ...(issue.parameterId === undefined
      ? {}
      : { parameterId: issue.parameterId }),
  };
}

export interface AuthoredWorkflowModelSelectionAdmissionDeps {
  agentBackends: AgentBackendsConfig;
  projectPath?: string;
  modelCatalogFor(backend: AgentBackendId): BackendModelCatalogFacet;
}

export type AuthoredWorkflowModelSelectionAdmissionResult =
  | { ok: true; launch: WorkflowDefinitionDraft }
  | { ok: false; issues: WorkflowModelSelectionIssue[] };

/**
 * Validate and canonicalize every complete selection carried by one authored
 * workflow. Catalog acquisition is cached per backend, while the traversal
 * remains role-complete across workflow, context, and loop-body use sites.
 */
export async function admitAuthoredWorkflowModelSelections(
  launch: WorkflowDefinitionDraft,
  deps: AuthoredWorkflowModelSelectionAdmissionDeps,
): Promise<AuthoredWorkflowModelSelectionAdmissionResult> {
  const canonicalLaunch = structuredClone(launch);
  const sites = mutableAuthoredSites(canonicalLaunch.definition);
  const catalogs = new Map<AgentBackendId, Promise<BackendModelCatalog>>();

  const catalogFor = (
    backend: AgentBackendId,
  ): Promise<BackendModelCatalog> => {
    let catalog = catalogs.get(backend);
    if (catalog === undefined) {
      catalog = Promise.resolve().then(() =>
        deps.modelCatalogFor(backend).getCatalog({
          ...(deps.projectPath === undefined
            ? {}
            : { projectPath: deps.projectPath }),
          configuredSelection: deps.agentBackends[backend].modelSelection,
        }),
      );
      catalogs.set(backend, catalog);
    }
    return catalog;
  };

  const issues: WorkflowModelSelectionIssue[] = [];
  for (const site of sites) {
    let catalog: BackendModelCatalog;
    try {
      catalog = await catalogFor(site.backend);
    } catch (error) {
      issues.push({
        path: site.path,
        message: `${site.role} ${site.backend} model catalog could not be loaded: ${getErrorMessage(error)}`,
        code: "catalog_unavailable",
        modelId: site.modelSelection.modelId,
      });
      continue;
    }

    const validation = validateModelSelection(catalog, site.modelSelection);
    if (!validation.valid) {
      issues.push(
        ...validation.issues.map((issue) => locatedIssue(site, issue)),
      );
      continue;
    }
    site.replace(validation.selection);
  }

  return issues.length === 0
    ? { ok: true, launch: canonicalLaunch }
    : { ok: false, issues };
}
