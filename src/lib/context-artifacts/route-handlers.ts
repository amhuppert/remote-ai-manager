/**
 * Context-artifact endpoints for both conversation scopes
 * (docs/design/conversation-compaction/README.md §9, §11).
 *
 * One handler core serves the session and project routes through the shared
 * route-resolution adapters. Auth follows the §11 matrix: every handler is
 * browser-facing/un-gated, but a bearer token — when present — is validated
 * (invalid → 401) and marks the caller as an agent for provenance stamping.
 * Handlers verify a fetched row's scope/project/session/conversation match
 * the path params so a leaked artifact id cannot cross scopes.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getProjectConversation as defaultGetProjectConversation,
} from "@/lib/state-store";
import { getStateDb } from "@/lib/state-store/store";
import {
  readTranscriptEntriesWithSeq as defaultReadTranscriptEntriesWithSeq,
  type TranscriptEntriesResult,
} from "@/lib/prompt/transcript";
import {
  groupTranscriptEntries,
  NORMALIZER_VERSION,
} from "@/lib/conversations/transcript-render";
import { resolveSessionRoute } from "@/lib/conversations/route-resolution";
import {
  resolveProjectOr404,
  jsonError,
  type RouteResolution,
} from "@/lib/shared/route-resolution";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import { CALLER_CONVERSATION_HEADER } from "@/lib/conversations/read-route-handlers";
import { broadcast } from "@/lib/events/broadcaster";
import { readConfig } from "@/lib/config/loader";
import { resolveCompactionConfig } from "@/lib/config/cascade";
import { readRepoConfig } from "@/lib/projects/repo-config";
import { executeWorkflowTaskRun } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { deriveFreshness, type ArtifactFreshness } from "./freshness";
import { PROMPT_VERSION } from "./generation";
import { createCompactionService, type CompactionService } from "./service";
import { createContextArtifactsRepo, type ContextArtifactsRepo } from "./repo";
import {
  artifactKindSchema,
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type ContextArtifactCreatedBy,
  type ContextArtifactRow,
  type ContextArtifactScope,
} from "./schemas";

const logger = createLogger("context-artifacts");

export interface ContextArtifactRouteDeps {
  resolveProjectPath(name: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<SessionState | null>;
  getProjectConversation(
    projectPath: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
  readTranscriptEntries(
    transcriptPath: string | null,
  ): Promise<TranscriptEntriesResult>;
  getService(): CompactionService;
  getRepo(): ContextArtifactsRepo;
  auth: AgentAuth;
}

// Lazy production singletons: the repo opens the shared SQLite handle and the
// service owns the process-wide single-flight map, so both must be created
// once and only when a request actually arrives (not at module import).
let _defaultRepo: ContextArtifactsRepo | null = null;
function getDefaultRepo(): ContextArtifactsRepo {
  _defaultRepo ??= createContextArtifactsRepo(getStateDb());
  return _defaultRepo;
}

let _defaultService: CompactionService | null = null;
function getDefaultService(): CompactionService {
  _defaultService ??= createCompactionService({
    executeTaskRun: executeWorkflowTaskRun,
    readEntries: defaultReadTranscriptEntriesWithSeq,
    repo: getDefaultRepo(),
    resolveConfig: async (projectPath) =>
      resolveCompactionConfig(
        await readConfig(),
        await readRepoConfig(projectPath),
      ),
    broadcast,
    now: () => new Date().toISOString(),
  });
  return _defaultService;
}

function defaultDeps(): ContextArtifactRouteDeps {
  return {
    resolveProjectPath: defaultResolveProjectPath,
    getSession: defaultGetSession,
    getProjectConversation: defaultGetProjectConversation,
    readTranscriptEntries: defaultReadTranscriptEntriesWithSeq,
    getService: getDefaultService,
    getRepo: getDefaultRepo,
    auth: createAgentAuth(),
  };
}

type RouteContext = { params: Promise<Record<string, string>> };

export const createOrRefreshRequestSchema = z
  .object({
    kind: artifactKindSchema,
    messageIndex: z.number().int().nonnegative().optional(),
    mode: z.literal("create_or_refresh"),
    force: z.boolean().optional(),
    wait: z.boolean().optional(),
    callerConversationId: z.string().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.kind === "message_compaction" && body.messageIndex === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["messageIndex"],
        message: "messageIndex is required for message_compaction",
      });
    }
    if (
      body.kind === "conversation_compaction" &&
      body.messageIndex !== undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["messageIndex"],
        message: "messageIndex is only valid for message_compaction",
      });
    }
  });
export type CreateOrRefreshRequest = z.infer<
  typeof createOrRefreshRequestSchema
>;

interface ArtifactTarget {
  scope: ContextArtifactScope;
  projectName: string;
  projectPath: string;
  sessionName: string | null;
  conversationId: string;
  conversation: ConversationState;
}

function conversationNotFound(): Response {
  return NextResponse.json(
    {
      error: "Conversation not found",
      code: "conversation_not_found",
    } satisfies ApiError,
    { status: 404 },
  );
}

function artifactNotFound(): Response {
  return NextResponse.json(
    {
      error: "Context artifact not found",
      code: "artifact_not_found",
    } satisfies ApiError,
    { status: 404 },
  );
}

function invalidRequest(issues: { path: string; message: string }[]): Response {
  return NextResponse.json(
    {
      error: "Invalid compaction request",
      code: "invalid_compaction_request",
      details: { issues },
      issues,
    },
    { status: 400 },
  );
}

/**
 * Derive read-time freshness for one row. Message artifacts are always fresh
 * (append-only transcripts never rewrite a message's own lines — §16 item 1);
 * only version drift can mark them outdated. `staleBehindMessages` counts
 * merged logical messages (the UI's message coordinate), not raw JSONL
 * entries — a coverage boundary inside a merged unit counts that unit once.
 */
function freshnessFor(
  row: ContextArtifactRow,
  current: TranscriptEntriesResult,
): ArtifactFreshness {
  const versions = {
    promptVersion: PROMPT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
  };
  if (row.kind === "message_compaction") {
    const derived = deriveFreshness(row, {
      ...versions,
      maxSeq: current.maxSeq,
    });
    return { stale: false, staleBehindMessages: 0, outdated: derived.outdated };
  }
  const staleBehindUnitCount = groupTranscriptEntries(current.entries).filter(
    (unit) => {
      const lastPart = unit.parts[unit.parts.length - 1];
      return lastPart !== undefined && lastPart.seq > row.coveredEndSeq;
    },
  ).length;
  return deriveFreshness(
    row,
    { ...versions, maxSeq: current.maxSeq },
    staleBehindUnitCount,
  );
}

function toListItem(
  row: ContextArtifactRow,
  current: TranscriptEntriesResult,
): Record<string, unknown> {
  const item: Record<string, unknown> = {
    ...row,
    ...freshnessFor(row, current),
  };
  delete item["payload"];
  return item;
}

function toFullItem(
  row: ContextArtifactRow,
  current: TranscriptEntriesResult,
): Record<string, unknown> {
  return { ...row, ...freshnessFor(row, current) };
}

function rowMatchesTarget(
  row: ContextArtifactRow,
  target: ArtifactTarget,
): boolean {
  return (
    row.scope === target.scope &&
    row.projectPath === target.projectPath &&
    row.sessionName === target.sessionName &&
    row.conversationId === target.conversationId
  );
}

export function createContextArtifactRouteHandlers(
  deps: ContextArtifactRouteDeps = defaultDeps(),
) {
  async function resolveSessionTarget(
    context: RouteContext,
  ): Promise<RouteResolution<ArtifactTarget>> {
    const base = await resolveSessionRoute(deps, context);
    if (!base.ok) return base;

    const params = await context.params;
    const conversationId = params["conversationId"] ?? "";
    const conversation = base.value.session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) {
      return { ok: false, response: conversationNotFound() };
    }
    return {
      ok: true,
      value: {
        scope: "session",
        projectName: params["name"] ?? "",
        projectPath: base.value.projectPath,
        sessionName: base.value.sessionName,
        conversationId,
        conversation,
      },
    };
  }

  async function resolveProjectTarget(
    context: RouteContext,
  ): Promise<RouteResolution<ArtifactTarget>> {
    const params = await context.params;
    const project = await resolveProjectOr404(deps, params["name"] ?? "");
    if (!project.ok) return project;

    const conversationId = params["conversationId"] ?? "";
    const conversation = await deps.getProjectConversation(
      project.value,
      conversationId,
    );
    if (!conversation) {
      return { ok: false, response: conversationNotFound() };
    }
    return {
      ok: true,
      value: {
        scope: "project",
        projectName: params["name"] ?? "",
        projectPath: project.value,
        sessionName: null,
        conversationId,
        conversation,
      },
    };
  }

  /** §11 soft gate: absent → un-gated, invalid → 401, valid → agent caller. */
  async function resolveCaller(
    request: Request,
    bodyCallerConversationId?: string,
  ): Promise<
    | {
        ok: true;
        createdBy: ContextArtifactCreatedBy;
        callerConversationId: string | null;
      }
    | { ok: false; response: Response }
  > {
    const validation = await deps.auth.validateOptionalToken(request);
    if (validation.kind === "invalid") {
      return {
        ok: false,
        response: jsonError("Invalid Command Center API token", 401),
      };
    }
    if (validation.kind === "valid") {
      return {
        ok: true,
        createdBy: "agent",
        callerConversationId:
          bodyCallerConversationId ??
          request.headers.get(CALLER_CONVERSATION_HEADER) ??
          null,
      };
    }
    return { ok: true, createdBy: "user", callerConversationId: null };
  }

  async function readCurrentEntries(
    target: ArtifactTarget,
  ): Promise<RouteResolution<TranscriptEntriesResult>> {
    try {
      return {
        ok: true,
        value: await deps.readTranscriptEntries(
          target.conversation.transcriptPath,
        ),
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read transcript";
      logger.error("artifact.route.transcript_read_failed", {
        conversationId: target.conversationId,
        error: message,
      });
      return { ok: false, response: jsonError(message, 500) };
    }
  }

  async function list(
    _request: Request,
    target: ArtifactTarget,
  ): Promise<Response> {
    const current = await readCurrentEntries(target);
    if (!current.ok) return current.response;

    const rows = deps
      .getRepo()
      .findByConversation(target.conversationId)
      .filter((row) => rowMatchesTarget(row, target));
    return NextResponse.json(rows.map((row) => toListItem(row, current.value)));
  }

  async function create(
    request: Request,
    target: ArtifactTarget,
  ): Promise<Response> {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return invalidRequest([
        { path: "", message: "request body must be JSON" },
      ]);
    }
    const parsed = createOrRefreshRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return invalidRequest(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      );
    }
    const body = parsed.data;

    const caller = await resolveCaller(request, body.callerConversationId);
    if (!caller.ok) return caller.response;

    const result = await deps.getService().trigger({
      kind: body.kind,
      scope: target.scope,
      projectPath: target.projectPath,
      projectName: target.projectName,
      sessionName: target.sessionName,
      conversationId: target.conversationId,
      transcriptPath: target.conversation.transcriptPath,
      ...(body.messageIndex !== undefined
        ? { messageIndex: body.messageIndex }
        : {}),
      ...(body.force !== undefined ? { force: body.force } : {}),
      createdBy: caller.createdBy,
      createdByConversationId: caller.callerConversationId,
      trigger: caller.createdBy === "agent" ? "agent_api" : "ui_api",
    });

    if (result.outcome === "invalid") {
      return invalidRequest([{ path: "", message: result.error }]);
    }

    if (result.outcome === "already_fresh") {
      const current = await readCurrentEntries(target);
      if (!current.ok) return current.response;
      return NextResponse.json({
        artifact: toFullItem(result.artifact, current.value),
        hint: "already fresh",
      });
    }

    if (body.wait === true) {
      const row = await raceCompletion(result.completion, result.timeoutMs);
      if (row !== null) {
        const current = await readCurrentEntries(target);
        if (!current.ok) return current.response;
        return NextResponse.json({
          artifact: toFullItem(row, current.value),
        });
      }
    }

    return NextResponse.json(
      { artifactId: result.artifactId, status: "pending" },
      { status: 202 },
    );
  }

  async function getOne(
    _request: Request,
    target: ArtifactTarget,
    artifactId: string,
  ): Promise<Response> {
    const row = deps.getRepo().findById(artifactId);
    if (!row || !rowMatchesTarget(row, target)) return artifactNotFound();

    const current = await readCurrentEntries(target);
    if (!current.ok) return current.response;
    return NextResponse.json(toFullItem(row, current.value));
  }

  async function remove(
    _request: Request,
    target: ArtifactTarget,
    artifactId: string,
  ): Promise<Response> {
    const repo = deps.getRepo();
    const row = repo.findById(artifactId);
    if (!row || !rowMatchesTarget(row, target)) return artifactNotFound();

    repo.deleteById(artifactId);
    logger.info("artifact.deleted", {
      artifactId,
      conversationId: target.conversationId,
      kind: row.kind,
      scope: target.scope,
    });
    return NextResponse.json({ deleted: true });
  }

  type ScopedHandler = (
    request: Request,
    target: ArtifactTarget,
  ) => Promise<Response>;
  type ScopedItemHandler = (
    request: Request,
    target: ArtifactTarget,
    artifactId: string,
  ) => Promise<Response>;

  function withTarget(
    resolveTarget: (
      context: RouteContext,
    ) => Promise<RouteResolution<ArtifactTarget>>,
    handler: ScopedHandler,
  ) {
    return async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => {
      const validation = await deps.auth.validateOptionalToken(request);
      if (validation.kind === "invalid") {
        return jsonError("Invalid Command Center API token", 401);
      }
      const target = await resolveTarget(context);
      if (!target.ok) return target.response;
      return handler(request, target.value);
    };
  }

  function withItemTarget(
    resolveTarget: (
      context: RouteContext,
    ) => Promise<RouteResolution<ArtifactTarget>>,
    handler: ScopedItemHandler,
  ) {
    return async (
      request: Request,
      context: RouteContext,
    ): Promise<Response> => {
      const validation = await deps.auth.validateOptionalToken(request);
      if (validation.kind === "invalid") {
        return jsonError("Invalid Command Center API token", 401);
      }
      const target = await resolveTarget(context);
      if (!target.ok) return target.response;
      const params = await context.params;
      return handler(request, target.value, params["artifactId"] ?? "");
    };
  }

  return {
    sessionList: withTarget(resolveSessionTarget, list),
    sessionCreate: withTarget(resolveSessionTarget, create),
    sessionGetOne: withItemTarget(resolveSessionTarget, getOne),
    sessionDelete: withItemTarget(resolveSessionTarget, remove),
    projectList: withTarget(resolveProjectTarget, list),
    projectCreate: withTarget(resolveProjectTarget, create),
    projectGetOne: withItemTarget(resolveProjectTarget, getOne),
    projectDelete: withItemTarget(resolveProjectTarget, remove),
  };
}

/** Resolve to the completed row, or null once `timeoutMs` elapses (§9 wait). */
export async function raceCompletion(
  completion: Promise<ContextArtifactRow>,
  timeoutMs: number,
): Promise<ContextArtifactRow | null> {
  // A non-positive timeout means "no timeout" (the task-run convention): wait
  // for completion rather than racing a 0ms timer that would resolve to null
  // immediately and defeat `wait=true`.
  if (timeoutMs <= 0) return completion;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      completion,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultHandlers = createContextArtifactRouteHandlers();
export const listSessionConversationArtifacts = withTracing(
  _defaultHandlers.sessionList,
);
export const createSessionConversationArtifact = withTracing(
  _defaultHandlers.sessionCreate,
);
export const getSessionConversationArtifact = withTracing(
  _defaultHandlers.sessionGetOne,
);
export const deleteSessionConversationArtifact = withTracing(
  _defaultHandlers.sessionDelete,
);
export const listProjectConversationArtifacts = withTracing(
  _defaultHandlers.projectList,
);
export const createProjectConversationArtifact = withTracing(
  _defaultHandlers.projectCreate,
);
export const getProjectConversationArtifact = withTracing(
  _defaultHandlers.projectGetOne,
);
export const deleteProjectConversationArtifact = withTracing(
  _defaultHandlers.projectDelete,
);
