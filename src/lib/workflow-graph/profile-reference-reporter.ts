/**
 * The workflow domain's answer to "who still references this agent profile?"
 * (R15, D14).
 *
 * This implements a port the agent-profile library declares, which is what
 * keeps the dependency arrow pointing one way: the library knows that
 * references exist and when to ask about them, and nothing about where they
 * live. Workflow definitions, global templates, and `workflowDefaults` are this
 * domain's storage, so the scan lives here and the route composition wires the
 * two together.
 *
 * It is a DIRECT SCAN on every call — no index, no cache, no invalidation. For
 * a single-user tool a dialog-open filesystem walk of one config directory is
 * cheaper than the staleness a cache would have to be defended against, and a
 * stale "nothing references this" is precisely the wrong answer to be fast
 * about.
 *
 * The enumeration is ADVISORY. It is a photograph, not a lock: a reference
 * authored between the preview and the delete is caught by the fail-closed
 * reference check at validate and at execution start, never by a recheck here.
 */

import type {
  AgentProfileReferenceReporter,
  AgentProfileProjectScope,
} from "@/lib/agent-profiles/library-service";
import type {
  AgentProfileRef,
  AgentProfileReferenceHolder,
  AgentProfileReferenceScope,
  AgentProfileSavedReferences,
} from "@/lib/agent-profiles/schemas";
import { readConfig } from "@/lib/config/loader";
import type { WorkflowDefaults } from "@/lib/config/schemas";
import { createLogger } from "@/lib/logging";

import {
  collectDefaultsReferenceSites,
  collectDefinitionReferenceSites,
  type AssignmentReferenceSite,
} from "./assignment-references";
import type { WorkflowDefinitionRecord } from "./definition-schemas";
import {
  createWorkflowStorageService,
  type WorkflowDefinitionSummary,
  type WorkflowScope,
} from "./storage";

const logger = createLogger("workflow-profile-references");

/**
 * The slice of the scope-aware storage service this reporter depends on.
 * Method syntax (not property) keeps parameter checking bivariant so the real
 * `createWorkflowStorageService()` return value satisfies it structurally.
 */
export interface WorkflowProfileReferenceStorage {
  listScopes(): Promise<WorkflowScope[]>;
  list(scope: WorkflowScope): Promise<WorkflowDefinitionSummary[]>;
  get(
    scope: WorkflowScope,
    workflowId: string,
  ): Promise<WorkflowDefinitionRecord | null>;
}

export interface WorkflowProfileReferenceReporterDeps {
  storage?: WorkflowProfileReferenceStorage;
  readWorkflowDefaults?: () => Promise<Partial<WorkflowDefaults> | undefined>;
}

function sameRef(a: AgentProfileRef, b: AgentProfileRef): boolean {
  return a.tier === b.tier && a.id === b.id;
}

function referenceScopeOf(scope: WorkflowScope): AgentProfileReferenceScope {
  return scope.kind === "global"
    ? { kind: "global" }
    : { kind: "project", projectPath: scope.projectPath };
}

function holderOf(
  scope: WorkflowScope,
  record: WorkflowDefinitionRecord,
  site: AssignmentReferenceSite,
): AgentProfileReferenceHolder {
  return {
    scope: referenceScopeOf(scope),
    id: record.id,
    name: record.name,
    ...(site.tier.kind === "context" ? { contextId: site.tier.contextId } : {}),
    dormant: site.dormant,
  };
}

/**
 * One row per distinct place a human would go to fix the reference. Two
 * validators in the same cohort pointing at the same profile are one place, so
 * they collapse; an active implementer and a dormant validator in that same
 * context are two, and stay two.
 */
function holderKey(holder: AgentProfileReferenceHolder): string {
  const scopeKey =
    holder.scope.kind === "global" ? "global" : holder.scope.projectPath;
  return [scopeKey, holder.id, holder.contextId ?? "", holder.dormant].join(
    "\u0000",
  );
}

function compareHolders(
  a: AgentProfileReferenceHolder,
  b: AgentProfileReferenceHolder,
): number {
  return holderKey(a).localeCompare(holderKey(b));
}

export function createWorkflowProfileReferenceReporter(
  deps: WorkflowProfileReferenceReporterDeps = {},
): AgentProfileReferenceReporter {
  const storage = deps.storage ?? createWorkflowStorageService();
  const readWorkflowDefaults =
    deps.readWorkflowDefaults ??
    (async () => (await readConfig()).workflowDefaults);

  /**
   * Which stored scopes can hold a reference to this profile at all.
   *
   * A project-tier profile exists only inside its own project, and the
   * global-document rule refuses it everywhere else, so scanning other projects
   * for it would be work that cannot find anything. A global (or builtin) tier
   * profile is reachable from every project AND from the global template scope,
   * which is exactly the cross-project sweep R15 asks for.
   */
  async function scopesFor(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<WorkflowScope[]> {
    if (ref.tier === "project") {
      return projectPath === null ? [] : [{ kind: "project", projectPath }];
    }
    return storage.listScopes();
  }

  async function holdersInScope(
    scope: WorkflowScope,
    ref: AgentProfileRef,
  ): Promise<AgentProfileReferenceHolder[]> {
    const summaries = await storage.list(scope);
    const holders: AgentProfileReferenceHolder[] = [];

    for (const summary of summaries) {
      const record = await storage.get(scope, summary.id);
      if (record === null) continue;
      for (const site of collectDefinitionReferenceSites(
        record.definition,
        "definition",
      )) {
        if (!sameRef(site.ref, ref)) continue;
        holders.push(holderOf(scope, record, site));
      }
    }

    return holders;
  }

  async function referencedByWorkflowDefaults(
    ref: AgentProfileRef,
  ): Promise<boolean> {
    const defaults = await readWorkflowDefaults();
    return collectDefaultsReferenceSites(defaults, "workflowDefaults").some(
      (site) => sameRef(site.ref, ref),
    );
  }

  function dedupe(
    holders: AgentProfileReferenceHolder[],
  ): AgentProfileReferenceHolder[] {
    const byKey = new Map<string, AgentProfileReferenceHolder>();
    for (const holder of holders) byKey.set(holderKey(holder), holder);
    return [...byKey.values()].sort(compareHolders);
  }

  return {
    async enumerateSavedReferences(
      projectPath: AgentProfileProjectScope,
      ref: AgentProfileRef,
    ): Promise<AgentProfileSavedReferences> {
      const scopes = await scopesFor(projectPath, ref);
      const found = (
        await Promise.all(scopes.map((scope) => holdersInScope(scope, ref)))
      ).flat();

      const references: AgentProfileSavedReferences = {
        definitions: dedupe(
          found.filter((holder) => holder.scope.kind === "project"),
        ),
        templates: dedupe(
          found.filter((holder) => holder.scope.kind === "global"),
        ),
        workflowDefaults: await referencedByWorkflowDefaults(ref),
      };

      // Counts and scope breadth only: workflow names and context ids are
      // authored content, and the log has no reason to carry them.
      logger.debug("workflow-profile-references.enumerated", {
        tier: ref.tier,
        scopeCount: scopes.length,
        definitionCount: references.definitions.length,
        templateCount: references.templates.length,
        workflowDefaults: references.workflowDefaults,
      });

      return references;
    },
  };
}
