/**
 * The run template library's boundary for CRUD and launch preparation. It
 * lists both tiers a project sees, reads one template, and saves or deletes
 * one with compare-and-swap; a save is checked first (`validateRunTemplate`,
 * then every profile the template names, resolved from the template's own
 * scope). A launch reads the template here and materialises it into the
 * workflow request the run routes launch. The one exception is the
 * agent-profile deletion report, whose composition reads storage through
 * `profile-references.ts`.
 */
import {
  formatAgentProfileRef,
  type AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import type { RunOrigin, RunTemplateTier } from "@/lib/runs/schemas";
import type { WorkflowLaunchRequest } from "@/lib/runs/workflow-definition";

import {
  materializeRunTemplate,
  profileSitesOf,
  validateRunTemplate,
  type RunTemplateContent,
  type RunTemplateRecord,
} from "./document";
import {
  issueAt,
  runTemplateIdSchema,
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

/** Why a template cannot be launched as asked; nothing was launched. */
export type RunTemplateLaunchRefusal =
  | { code: "run_template_invalid_id"; message: string }
  | { code: "run_template_not_found"; message: string }
  /** The template changed since the revision the launch names. */
  | { code: "run_template_changed"; message: string; currentRevision: number }
  /** A parameter value at `parameters.<name>`, or what the values make of the template, at its path. */
  | {
      code: "run_template_launch_invalid";
      message: string;
      issues: RunTemplateIssue[];
    };

export type RunTemplateLaunchPreparation =
  | { ok: true; request: WorkflowLaunchRequest; origin: RunOrigin }
  | { ok: false; refusal: RunTemplateLaunchRefusal };

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
  /**
   * The workflow launch request the template makes with these values, and the
   * origin the run records. `revision`, when given, is the one the person
   * launching saw: a template changed since is refused, not launched.
   */
  prepareLaunch(input: {
    projectPath: string;
    tier: RunTemplateTier;
    id: string;
    revision?: number;
    parameters: Readonly<Record<string, string>>;
  }): Promise<RunTemplateLaunchPreparation>;
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
    const issues: RunTemplateIssue[] = [];
    for (const { path, ref } of profileSitesOf(content)) {
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

    async prepareLaunch({ projectPath, tier, id, revision, parameters }) {
      const validId = runTemplateIdSchema.safeParse(id);
      if (!validId.success)
        return {
          ok: false,
          refusal: {
            code: "run_template_invalid_id",
            message: `Invalid run template id ${JSON.stringify(id)}: ${validId.error.issues[0]?.message ?? "malformed"}`,
          },
        };
      const read = await storage.get(scopeForTier(tier, projectPath), id);
      if (read.kind !== "found")
        return {
          ok: false,
          refusal: {
            code: "run_template_not_found",
            message:
              read.kind === "absent"
                ? `Run template ${tier}:${id} does not exist`
                : `Run template ${tier}:${id} cannot be read (${read.reason}); fix or remove ${read.path}`,
          },
        };
      const { record } = read;
      if (revision !== undefined && record.revision !== revision)
        return {
          ok: false,
          refusal: {
            code: "run_template_changed",
            message: `Run template ${tier}:${id} changed since revision ${revision}: it is at revision ${record.revision} now; read it again before launching it`,
            currentRevision: record.revision,
          },
        };
      const materialized = materializeRunTemplate(record, parameters);
      if (!materialized.ok)
        return {
          ok: false,
          refusal: {
            code: "run_template_launch_invalid",
            message: `The launch has ${materialized.issues.length} ${materialized.issues.length === 1 ? "problem" : "problems"}`,
            issues: materialized.issues,
          },
        };
      return {
        ok: true,
        request: materialized.request,
        origin: {
          kind: "template",
          tier,
          id,
          revision: record.revision,
          name: record.name,
        },
      };
    },
  };
}
