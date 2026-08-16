/**
 * Agent-facing workflow-plan validation endpoint (docs/design/cc-cli/02 §3.1).
 *
 * - POST /api/projects/[name]/sessions/[session]/graph-workflow/validate[?tier=]
 *   Body: the same `{ name, description?, definition, layout }` a create/replace
 *   accepts; `?tier=global|project` (default project) selects which document
 *   scope the assignment rules are applied under, mirroring the scope the plan
 *   will be saved to. Runs shared authored-launch admission and PERSISTS NOTHING —
 *   it has no storage dependency by design. Returns `{ ok: true }` (200) or
 *   `{ error, issues[] }` (400) with JSON-path locations. Token-gated. Backs
 *   `cctl workflow validate --file plan.json`; the browser UI never calls it.
 */

import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config/loader";
import { resolveProjectSessionOr404 } from "@/lib/shared/route-resolution";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { readRepoConfig } from "@/lib/projects/repo-config";
import type { GlobalConfig, PerRepoConfig } from "@/lib/config/schemas";
import { getSession } from "@/lib/state-store";
import { createLogger, withTracing } from "@/lib/logging";
import type { ApiError } from "@/lib/api/errors";
import { admitAuthoredWorkflowLaunch } from "./authored-launch-admission";
import {
  type AssignmentDocumentScope,
  type AssignmentReferenceChecker,
  WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE,
} from "./assignment-references";

const log = createLogger("graph-workflow-validate-route");

const DOCUMENT_TIERS = ["global", "project"] as const;

/**
 * Which scope the plan is destined for, from `?tier=` (default project).
 *
 * Validate is the pre-flight for a save, so it has to apply the SAME rules the
 * save will. A plan headed for the global template library is a global-scope
 * document, and its project-tier assignment references are unresolvable there
 * (R4.2) — without this selector such a plan would validate clean and only be
 * refused at save. An unrecognized value is refused rather than defaulted: a
 * typo'd `--tier` silently checking the weaker project rules is the failure
 * mode the selector exists to prevent.
 */
function resolveDocumentScope(
  requestUrl: string,
  projectPath: string,
): { ok: true; scope: AssignmentDocumentScope } | { ok: false; error: string } {
  const tier = new URL(requestUrl).searchParams.get("tier");
  if (tier === null || tier === "project") {
    return { ok: true, scope: { kind: "project", projectPath } };
  }
  if (tier === "global") return { ok: true, scope: { kind: "global" } };
  return {
    ok: false,
    error: `tier must be one of: ${DOCUMENT_TIERS.join(", ")}`,
  };
}

export interface GraphWorkflowValidateRouteDeps {
  auth: AgentAuth;
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<{ sessionName: string } | null>;
  /**
   * Reads `CommandCenter.json` so command selections can be preflighted
   * against the project's validation registry and global capacity so this
   * endpoint retains exact create-path parity (validation-concurrency §§3, 6).
   */
  readRepoConfig(projectPath: string): Promise<PerRepoConfig | null>;
  /**
   * The CURRENT global config, read per request. Validate is the pre-flight for
   * a launch, and the launch staffs from `workflowDefaults` as well as from the
   * plan, so answering "would this launch?" means reading them now rather than
   * trusting whatever was valid when they were written.
   */
  readConfig(): Promise<GlobalConfig>;
  assignmentReferences?: AssignmentReferenceChecker;
}

export function createGraphWorkflowValidateHandlers(
  deps: GraphWorkflowValidateRouteDeps,
) {
  const assignmentReferences = deps.assignmentReferences;
  async function post(
    request: Request,
    { params }: { params: Promise<Record<string, string>> },
  ): Promise<Response> {
    const denied = await deps.auth.requireToken(request);
    if (denied) return denied;

    const { name, session } = await params;
    const projectName = name ?? "";
    const sessionName = session ?? "";

    const resolved = await resolveProjectSessionOr404(
      deps,
      projectName,
      sessionName,
    );
    if (!resolved.ok) return resolved.response;

    const selected = resolveDocumentScope(
      request.url,
      resolved.value.projectPath,
    );
    if (!selected.ok) {
      return NextResponse.json({ error: selected.error } satisfies ApiError, {
        status: 400,
      });
    }
    const scope = selected.scope;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Request body must be JSON" } satisfies ApiError,
        { status: 400 },
      );
    }

    const [repoConfig, globalConfig] = await Promise.all([
      deps.readRepoConfig(resolved.value.projectPath),
      deps.readConfig(),
    ]);
    const validation = await admitAuthoredWorkflowLaunch(rawBody, {
      caller:
        scope.kind === "global"
          ? "global-template-validate"
          : "project-validate",
      documentScope: scope,
      projectValidation: repoConfig?.validation ?? null,
      globalValidation: globalConfig.validation,
      workflowDefaults: globalConfig.workflowDefaults,
      assignmentReferences,
    });
    if (!validation.ok) {
      log.info("graph-workflow-validate.invalid", {
        projectName,
        sessionName,
        code: validation.code ?? "invalid_plan",
        issueCount: validation.issues.length,
      });
      return NextResponse.json(
        {
          error: "Workflow plan is invalid",
          ...(validation.code === WORKFLOW_ASSIGNMENT_REFERENCE_INVALID_CODE
            ? {}
            : validation.code
              ? { code: validation.code }
              : {}),
          issues: validation.issues,
        },
        { status: 400 },
      );
    }

    log.info("graph-workflow-validate.ok", {
      projectName,
      sessionName,
      warningCount: validation.warnings.length,
    });
    // Warnings never change the verdict — the plan is valid — but the author
    // gets to see them before creating it (R3.2 enum coverage).
    return NextResponse.json(
      validation.warnings.length === 0
        ? { ok: true }
        : { ok: true, warnings: validation.warnings },
    );
  }

  return { POST: post };
}

const defaultHandlers = createGraphWorkflowValidateHandlers({
  auth: createAgentAuth(),
  resolveProjectPath,
  getSession,
  readRepoConfig,
  readConfig,
});

/** POST /api/projects/[name]/sessions/[session]/graph-workflow/validate */
export const POST = withTracing(defaultHandlers.POST);
