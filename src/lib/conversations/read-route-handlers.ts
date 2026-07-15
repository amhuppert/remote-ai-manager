/**
 * Compact-transcript read endpoint
 * (docs/design/conversation-compaction/README.md §5.1, §11).
 *
 * One handler pair serves both conversation scopes through the shared
 * route-resolution adapters; rendering is delegated to the pure
 * `renderCompactTranscript` normalizer over cached entry reads. GET is
 * browser-facing/un-gated, but a bearer token — when present — is validated
 * (invalid → 401) and the caller identity feeds the audit log per §11.
 */

import { NextResponse } from "next/server";
import { createLogger, withTracing } from "@/lib/logging";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  getProjectConversation as defaultGetProjectConversation,
} from "@/lib/state-store";
import {
  readTranscriptEntriesWithSeq as defaultReadTranscriptEntriesWithSeq,
  type TranscriptEntriesResult,
} from "@/lib/prompt/transcript";
import {
  renderCompactTranscript,
  renderedTranscriptToMarkdown,
  renderOptionsSchema,
  type RenderOptions,
} from "@/lib/conversations/transcript-render";
import { resolveSessionRoute } from "@/lib/conversations/route-resolution";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
} from "@/lib/shared/route-resolution";
import { createAgentAuth, type AgentAuth } from "@/lib/agent-gateway/token";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionState } from "@/lib/sessions/schemas";

const auditLogger = createLogger("context-artifacts.audit");
const readLogger = createLogger("context-artifacts.read");

/** Header agents set so cross-conversation reads carry caller identity. */
export const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

export interface ReadRouteDeps {
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
  auth: AgentAuth;
}

function defaultDeps(): ReadRouteDeps {
  return {
    resolveProjectPath: defaultResolveProjectPath,
    getSession: defaultGetSession,
    getProjectConversation: defaultGetProjectConversation,
    readTranscriptEntries: defaultReadTranscriptEntriesWithSeq,
    auth: createAgentAuth(),
  };
}

type RouteContext = { params: Promise<Record<string, string>> };

export interface ReadQueryIssue {
  path: string;
  message: string;
}

export type ParsedReadQuery =
  | { ok: true; options: RenderOptions }
  | { ok: false; issues: ReadQueryIssue[] };

const BOOLEAN_PARAMS = ["outline", "includeThinking", "includeDebug"] as const;
const INTEGER_PARAMS = ["message", "maxBytes"] as const;
const RANGE_PARAMS = ["messageRange", "seqRange"] as const;
const PASSTHROUGH_PARAMS = ["includeTools", "search", "format"] as const;

const INTEGER_PATTERN = /^-?\d+$/;
// Canonical range form is `A:B`; `A-B` (non-negative only, to stay
// unambiguous), `A,B`, and a bare `N` (→ N:N) are accepted as lenient
// aliases because agents reliably guess them before reading any docs.
const RANGE_PATTERN = /^(-?\d+):(-?\d+)$/;
const RANGE_DASH_PATTERN = /^(\d+)-(\d+)$/;
const RANGE_COMMA_PATTERN = /^(-?\d+),(-?\d+)$/;

/**
 * Coerce a raw query-string value toward the type `renderOptionsSchema`
 * expects. Values that do not coerce cleanly pass through as the raw string so
 * the schema reports a field-scoped issue instead of a silent fallback.
 */
function coerceBoolean(raw: string): boolean | string {
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return raw;
}

function coerceInteger(raw: string): number | string {
  return INTEGER_PATTERN.test(raw) ? Number(raw) : raw;
}

function coerceRange(raw: string): [number, number] | string {
  if (INTEGER_PATTERN.test(raw)) return [Number(raw), Number(raw)];
  const match =
    RANGE_PATTERN.exec(raw) ??
    RANGE_DASH_PATTERN.exec(raw) ??
    RANGE_COMMA_PATTERN.exec(raw);
  if (!match || match[1] === undefined || match[2] === undefined) return raw;
  return [Number(match[1]), Number(match[2])];
}

/**
 * Teaching text for a range value that failed every accepted form. The
 * messageRange variant also disambiguates message indexes from the `[sN]`
 * seq markers agents copy out of `--outline` output — the observed failure
 * mode is feeding seq coordinates to `--message-range`.
 */
function rangeSyntaxIssue(key: (typeof RANGE_PARAMS)[number]): ReadQueryIssue {
  return {
    path: key,
    message:
      key === "messageRange"
        ? "expected A:B message indexes (e.g. --message-range 2:3); the [sN] markers in --outline output are seq coordinates — window those with --seq-range"
        : "expected A:B seq numbers (e.g. --seq-range 120:180)",
  };
}

/**
 * Parse the read endpoint's query string into validated `RenderOptions`.
 * Pure: coercion (booleans, integers, `A:B` ranges) feeds
 * `renderOptionsSchema.safeParse`, and violations come back as
 * field-scoped issues for the 400 body.
 */
export function parseReadQuery(url: string): ParsedReadQuery {
  const searchParams = new URL(url).searchParams;
  const raw: Record<string, unknown> = {};
  const rangeIssues: ReadQueryIssue[] = [];

  for (const key of BOOLEAN_PARAMS) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = coerceBoolean(value);
  }
  for (const key of INTEGER_PARAMS) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = coerceInteger(value);
  }
  for (const key of RANGE_PARAMS) {
    const value = searchParams.get(key);
    if (value === null) continue;
    const coerced = coerceRange(value);
    // A failed coercion gets the teaching issue and stays out of `raw`, so
    // the schema does not stack its raw "expected tuple" issue on top.
    if (typeof coerced === "string") rangeIssues.push(rangeSyntaxIssue(key));
    else raw[key] = coerced;
  }
  for (const key of PASSTHROUGH_PARAMS) {
    const value = searchParams.get(key);
    if (value !== null) raw[key] = value;
  }

  const parsed = renderOptionsSchema.safeParse(raw);
  if (!parsed.success || rangeIssues.length > 0) {
    return {
      ok: false,
      issues: [
        ...rangeIssues,
        ...(parsed.success
          ? []
          : parsed.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            }))),
      ],
    };
  }
  return { ok: true, options: parsed.data };
}

function conversationNotFound(): Response {
  return notFound("Conversation not found", "conversation_not_found");
}

function invalidQueryResponse(issues: ReadQueryIssue[]): Response {
  return NextResponse.json(
    {
      error: "Invalid read options",
      code: "invalid_read_options",
      details: { issues },
      issues,
    },
    { status: 400 },
  );
}

/** The effective read window, logged with every served read (§7.6, §11). */
function windowFields(options: RenderOptions) {
  return {
    outline: options.outline,
    message: options.message ?? null,
    messageRange: options.messageRange ?? null,
    seqRange: options.seqRange ?? null,
    includeTools: options.includeTools,
    includeThinking: options.includeThinking,
    search: options.search !== undefined,
  };
}

interface ReadTarget {
  projectPath: string;
  sessionName: string | null;
  conversationId: string;
  conversation: ConversationState;
}

export function createReadRouteHandlers(deps: ReadRouteDeps = defaultDeps()) {
  async function serveRead(
    request: Request,
    target: ReadTarget,
  ): Promise<Response> {
    const query = parseReadQuery(request.url);
    if (!query.ok) return invalidQueryResponse(query.issues);
    const options = query.options;

    let result: TranscriptEntriesResult;
    try {
      result = await deps.readTranscriptEntries(
        target.conversation.transcriptPath,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read transcript";
      readLogger.error("read.failed", {
        targetConversationId: target.conversationId,
        error: message,
      });
      return NextResponse.json({ error: message } satisfies ApiError, {
        status: 500,
      });
    }

    const rendered = renderCompactTranscript(
      {
        conversationId: target.conversationId,
        entries: result.entries,
        maxSeq: result.maxSeq,
      },
      options,
    );

    const body =
      options.format === "markdown"
        ? renderedTranscriptToMarkdown(rendered)
        : JSON.stringify(rendered);
    const bytes = Buffer.byteLength(body, "utf-8");
    const window = windowFields(options);
    const callerConversationId =
      request.headers.get(CALLER_CONVERSATION_HEADER) ?? null;

    auditLogger.info("audit.conversation_read", {
      callerConversationId,
      targetConversationId: target.conversationId,
      projectPath: target.projectPath,
      sessionName: target.sessionName,
      window,
      bytes,
      truncated: rendered.truncated,
    });
    readLogger.info("read.served", {
      targetConversationId: target.conversationId,
      format: options.format,
      window,
      bytes,
      truncated: rendered.truncated,
      totalMessages: rendered.totalMessages,
      unitCount: rendered.units.length,
    });

    if (options.format === "markdown") {
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/markdown; charset=utf-8" },
      });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  async function checkOptionalToken(
    request: Request,
  ): Promise<Response | null> {
    const validation = await deps.auth.validateOptionalToken(request);
    if (validation.kind === "invalid") {
      return jsonError("Invalid Command Center API token", 401);
    }
    return null;
  }

  async function sessionGET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const denied = await checkOptionalToken(request);
    if (denied) return denied;

    const base = await resolveSessionRoute(deps, context);
    if (!base.ok) return base.response;

    const params = await context.params;
    const conversationId = params["conversationId"] ?? "";
    const conversation = base.value.session.conversations.find(
      (c) => c.id === conversationId,
    );
    if (!conversation) return conversationNotFound();

    return serveRead(request, {
      projectPath: base.value.projectPath,
      sessionName: base.value.sessionName,
      conversationId,
      conversation,
    });
  }

  async function projectGET(
    request: Request,
    context: RouteContext,
  ): Promise<Response> {
    const denied = await checkOptionalToken(request);
    if (denied) return denied;

    const params = await context.params;
    const project = await resolveProjectOr404(deps, params["name"] ?? "");
    if (!project.ok) return project.response;

    const conversationId = params["conversationId"] ?? "";
    const conversation = await deps.getProjectConversation(
      project.value,
      conversationId,
    );
    if (!conversation) return conversationNotFound();

    return serveRead(request, {
      projectPath: project.value,
      sessionName: null,
      conversationId,
      conversation,
    });
  }

  return { sessionGET, projectGET };
}

// ---------------------------------------------------------------------------
// Default named exports — consumed directly by route shells
// ---------------------------------------------------------------------------

const _defaultReadHandlers = createReadRouteHandlers();
export const getSessionConversationRead = withTracing(
  _defaultReadHandlers.sessionGET,
);
export const getProjectConversationRead = withTracing(
  _defaultReadHandlers.projectGET,
);
