/**
 * The run template library: the only module consumers call. It lists both
 * tiers a project sees, reads one template, and saves or deletes one with
 * compare-and-swap; a save is checked first (`validateRunTemplate`, then every
 * profile the template names, resolved from the template's own scope).
 */
import {
  formatAgentProfileRef,
  type AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import type { RunTemplateTier } from "@/lib/runs/schemas";
import type { RunSettingsPatch } from "@/lib/runs/settings";

import {
  validateRunTemplate,
  type RunTemplateContent,
  type RunTemplateRecord,
} from "./document";
import {
  issueAt,
  type RunTemplateIssue,
  type RunTemplateLibrary,
  type RunTemplateSummary,
} from "./schemas";
import {
  scopeForTier,
  type RunTemplateRead,
  type RunTemplateStorage,
  type RunTemplateStorageRefusal,
} from "./storage";

export type RunTemplateRefusal =
  | RunTemplateStorageRefusal
  | {
      code: "run_template_invalid";
      message: string;
      issues: RunTemplateIssue[];
    };

export type RunTemplateSaved =
  | { ok: true; record: RunTemplateRecord; action: "created" | "updated" }
  | { ok: false; refusal: RunTemplateRefusal };

export type RunTemplateDeleted =
  | { ok: true; record: RunTemplateRecord }
  | { ok: false; refusal: RunTemplateRefusal };

/** Whether a profile reference resolves where the template lives; the message says why not. */
export interface RunTemplateProfileCheck {
  check(
    projectPath: string | null,
    ref: AgentProfileRef,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
}

export interface RunTemplateServiceDeps {
  storage: RunTemplateStorage;
  profiles: RunTemplateProfileCheck;
}

export interface RunTemplateService {
  /** The project's templates and the global ones, with a diagnostic for each unreadable file. */
  list(projectPath: string): Promise<RunTemplateLibrary>;
  /** The template, its absence, or why and where its file cannot be read. */
  get(
    projectPath: string,
    tier: RunTemplateTier,
    id: string,
  ): Promise<RunTemplateRead>;
  /** Creates when `expectedRevision` is null; otherwise replaces that revision. */
  save(input: {
    projectPath: string;
    tier: RunTemplateTier;
    id: string;
    expectedRevision: number | null;
    content: unknown;
  }): Promise<RunTemplateSaved>;
  delete(input: {
    projectPath: string;
    tier: RunTemplateTier;
    id: string;
    expectedRevision: number;
  }): Promise<RunTemplateDeleted>;
}

/** Every profile a settings patch names, with its path inside the patch. */
function profilesIn(
  patch: RunSettingsPatch | undefined,
): Array<{ path: Array<string | number>; ref: AgentProfileRef }> {
  if (patch === undefined) return [];
  return [
    ...(patch.implementer === undefined
      ? []
      : [{ path: ["implementer", "profile"], ref: patch.implementer.profile }]),
    ...(patch.reviewers ?? []).map((reviewer, index) => ({
      path: ["reviewers", index, "profile"],
      ref: reviewer.profile,
    })),
  ];
}

function summaryOf(
  tier: RunTemplateTier,
  record: RunTemplateRecord,
): RunTemplateSummary {
  return {
    tier,
    id: record.id,
    name: record.name,
    description: record.description,
    contexts: record.workflow.contexts.length,
    parameters: record.parameters,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

export function createRunTemplateService(
  deps: RunTemplateServiceDeps,
): RunTemplateService {
  const { storage, profiles } = deps;

  /**
   * Each profile reference that does not resolve from the template's scope. A
   * global template serves every project, so a project profile is refused
   * outright rather than resolved against the project that saved it.
   */
  async function profileIssues(
    projectPath: string,
    tier: RunTemplateTier,
    content: RunTemplateContent,
  ): Promise<RunTemplateIssue[]> {
    const named = [
      ...profilesIn(content.defaults).map(({ path, ref }) => ({
        path: ["defaults", ...path],
        ref,
      })),
      ...content.workflow.contexts.flatMap((context, index) =>
        profilesIn(context.settings).map(({ path, ref }) => ({
          path: ["workflow", "contexts", index, "settings", ...path],
          ref,
        })),
      ),
    ];
    const issues: RunTemplateIssue[] = [];
    for (const { path, ref } of named) {
      if (tier === "global" && ref.tier === "project") {
        issues.push(
          issueAt(
            path,
            `${formatAgentProfileRef(ref)} is a project profile, and a global template is used by every project: name a builtin or global profile`,
          ),
        );
        continue;
      }
      const resolved = await profiles.check(
        tier === "global" ? null : projectPath,
        ref,
      );
      if (!resolved.ok) issues.push(issueAt(path, resolved.message));
    }
    return issues;
  }

  return {
    async list(projectPath) {
      const [project, global] = await Promise.all([
        storage.list(scopeForTier("project", projectPath)),
        storage.list(scopeForTier("global", projectPath)),
      ]);
      return {
        items: [
          ...project.records.map((record) => summaryOf("project", record)),
          ...global.records.map((record) => summaryOf("global", record)),
        ],
        diagnostics: [
          ...project.diagnostics.map((d) => ({
            tier: "project" as const,
            ...d,
          })),
          ...global.diagnostics.map((d) => ({ tier: "global" as const, ...d })),
        ],
      };
    },

    get(projectPath, tier, id) {
      return storage.get(scopeForTier(tier, projectPath), id);
    },

    async save({ projectPath, tier, id, expectedRevision, content: raw }) {
      const validated = validateRunTemplate(raw);
      const issues = validated.ok
        ? await profileIssues(projectPath, tier, validated.content)
        : validated.issues;
      if (!validated.ok || issues.length > 0)
        return {
          ok: false,
          refusal: {
            code: "run_template_invalid",
            message: `The run template has ${issues.length} ${issues.length === 1 ? "problem" : "problems"}`,
            issues,
          },
        };
      const scope = scopeForTier(tier, projectPath);
      const written =
        expectedRevision === null
          ? await storage.create(scope, id, validated.content)
          : await storage.update(
              scope,
              id,
              expectedRevision,
              validated.content,
            );
      return written.ok
        ? {
            ok: true,
            record: written.record,
            action: expectedRevision === null ? "created" : "updated",
          }
        : written;
    },

    delete({ projectPath, tier, id, expectedRevision }) {
      return storage.delete(
        scopeForTier(tier, projectPath),
        id,
        expectedRevision,
      );
    },
  };
}
