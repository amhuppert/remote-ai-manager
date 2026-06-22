import type {
  ParameterDeclaration,
  WorkflowDefinitionRecord,
  WorkflowPrerequisite,
} from "@/lib/workflows/schemas";
import { createLogger } from "../logging";
import {
  createWorkflowStorageService,
  type WorkflowDefinitionSummary,
  type WorkflowScope,
} from "./storage";

const logger = createLogger("graph-workflow-template-library");

export type TemplateTier = "project" | "global";

export interface TemplateLibraryItem {
  tier: TemplateTier;
  id: string;
  name: string;
  description: string | null;
  revision: number;
  // Surfaced from the underlying definition so a consumer can build a launch
  // (parameter form + prerequisite gating) without a second per-item fetch.
  parameters: ParameterDeclaration[];
  prerequisites: WorkflowPrerequisite[];
}

export interface TemplateLibraryService {
  list(projectPath: string): Promise<TemplateLibraryItem[]>;
  resolve(input: {
    projectPath: string;
    tier: TemplateTier;
    id: string;
  }): Promise<WorkflowDefinitionRecord | null>;
}

/**
 * The slice of the scope-aware storage service the library depends on. A method
 * surface (not property syntax) keeps parameter checking bivariant so the real
 * `createWorkflowStorageService()` return value satisfies it structurally.
 */
export interface TemplateLibraryStorage {
  list(scope: WorkflowScope): Promise<WorkflowDefinitionSummary[]>;
  get(
    scope: WorkflowScope,
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null>;
}

export interface TemplateLibraryDeps {
  storage?: TemplateLibraryStorage;
}

/**
 * Single source of the tier→storage-scope mapping. Both the library's `resolve`
 * and every `loadDefinition` binding map through here so the global→`{kind:"global"}`
 * / project→`{kind:"project",projectPath}` correspondence lives in exactly one place.
 */
export function scopeForTier(
  tier: TemplateTier,
  projectPath: string,
): WorkflowScope {
  return tier === "global"
    ? { kind: "global" }
    : { kind: "project", projectPath };
}

function toItem(
  tier: TemplateTier,
  summary: WorkflowDefinitionSummary,
): TemplateLibraryItem {
  return {
    tier,
    id: summary.id,
    name: summary.name,
    description: summary.description,
    revision: summary.revision,
    parameters: summary.parameters,
    prerequisites: summary.prerequisites,
  };
}

export function createTemplateLibraryService(
  deps: TemplateLibraryDeps = {},
): TemplateLibraryService {
  const storage = deps.storage ?? createWorkflowStorageService();

  async function list(projectPath: string): Promise<TemplateLibraryItem[]> {
    // One storage `list` per tier (never a per-item `get`); the summary already
    // carries parameters + prerequisites. Same-name templates across tiers are
    // intentionally listed distinctly — the global and project tiers are sibling
    // scopes, so a project may legitimately hold a template that shares a name
    // with a global one, and the consumer needs to choose between them by tier.
    const [globalSummaries, projectSummaries] = await Promise.all([
      storage.list({ kind: "global" }),
      storage.list({ kind: "project", projectPath }),
    ]);

    const items = [
      ...globalSummaries.map((summary) => toItem("global", summary)),
      ...projectSummaries.map((summary) => toItem("project", summary)),
    ];

    logger.debug("template-library.list", {
      globalCount: globalSummaries.length,
      projectCount: projectSummaries.length,
    });

    return items;
  }

  async function resolve(input: {
    projectPath: string;
    tier: TemplateTier;
    id: string;
  }): Promise<WorkflowDefinitionRecord | null> {
    // Read-only: load from the indicated tier only and return the stored record
    // unchanged (never copied, moved, or modified — R3.5).
    return storage.get(scopeForTier(input.tier, input.projectPath), input.id);
  }

  return { list, resolve };
}
