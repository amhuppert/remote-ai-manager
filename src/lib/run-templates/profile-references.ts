/**
 * The run template library's share of the agent-profile deletion report: the
 * templates that name a profile, and where in them. A direct scan on every
 * call, like the workflow share beside it; advisory, never a lock, since a
 * launch resolves every seat's profile again.
 */
import type {
  AgentProfileProjectScope,
  AgentProfileRunTemplateReferenceReporter,
} from "@/lib/agent-profiles/library-service";
import type {
  AgentProfileRef,
  AgentProfileRunTemplateHolder,
} from "@/lib/agent-profiles/schemas";

import { profileSitesOf } from "./document";
import type { RunTemplateScope, RunTemplateStorage } from "./storage";

function sameRef(a: AgentProfileRef, b: AgentProfileRef): boolean {
  return a.tier === b.tier && a.id === b.id;
}

function holderKey(holder: AgentProfileRunTemplateHolder): string {
  const scope =
    holder.scope.kind === "global" ? "global" : holder.scope.projectPath;
  return [scope, holder.id, holder.contextId ?? ""].join("\u0000");
}

export function createRunTemplateProfileReferences(deps: {
  storage: Pick<RunTemplateStorage, "list" | "listScopes">;
}): AgentProfileRunTemplateReferenceReporter {
  const { storage } = deps;

  /**
   * A project profile exists only in its own project, and a global template
   * may not name one, so only that project's templates can hold it; a
   * profile of any other tier can be named by every project's templates and
   * the global ones.
   */
  async function scopesFor(
    projectPath: AgentProfileProjectScope,
    ref: AgentProfileRef,
  ): Promise<RunTemplateScope[]> {
    if (ref.tier !== "project") return storage.listScopes();
    return projectPath === null ? [] : [{ kind: "project", projectPath }];
  }

  return {
    async runTemplateHolders(projectPath, ref) {
      const listings = await Promise.all(
        (await scopesFor(projectPath, ref)).map(async (scope) => ({
          scope,
          // An unreadable template's references cannot be known; its listing diagnostic names the file.
          records: (await storage.list(scope)).records,
        })),
      );
      // One row per place a person would go to change it: two reviewers in one context are one.
      const byPlace = new Map<string, AgentProfileRunTemplateHolder>();
      for (const { scope, records } of listings)
        for (const record of records)
          for (const site of profileSitesOf(record)) {
            if (!sameRef(site.ref, ref)) continue;
            const holder: AgentProfileRunTemplateHolder = {
              scope:
                scope.kind === "global"
                  ? { kind: "global" }
                  : { kind: "project", projectPath: scope.projectPath },
              id: record.id,
              name: record.name,
              ...(site.contextKey !== null
                ? { contextId: site.contextKey }
                : {}),
            };
            byPlace.set(holderKey(holder), holder);
          }
      return [...byPlace.values()].sort((a, b) =>
        holderKey(a).localeCompare(holderKey(b)),
      );
    },
  };
}
