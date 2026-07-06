import { z } from "zod";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  cliRequest,
  cliRequestText,
  encodePathSegment,
  failure,
  failureFromRequest,
  failureFromRequestNotFoundAsUsage,
  render,
  resolveProjectContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type GlobalFlags,
  type TokenSource,
} from "../shared";

/**
 * `cctl conversation read|compact|compaction get|list` — windowed transcript
 * reads and compaction artifacts (docs/design/conversation-compaction §5.2,
 * §10). The CLI never parses transcript files locally; everything goes
 * through the read/context-artifact endpoints.
 */

/** Audit header the read endpoint stamps into `audit.conversation_read`. */
const CALLER_CONVERSATION_HEADER = "x-cc-conversation-id";

const POLL_INTERVAL_MS = 1_000;
const POLL_MAX_ATTEMPTS = 300;

const INTEGER_PATTERN = /^\d+$/;

const readUnitSchema = z.object({
  ref: z.object({
    messageIndex: z.number().int(),
    seqStart: z.number().int(),
    seqEnd: z.number().int(),
  }),
  role: z.string(),
  timestamp: z.string(),
  lines: z.array(z.string()),
});
const readResponseSchema = z.object({
  totalMessages: z.number().int(),
  maxSeq: z.number().int(),
  units: z.array(readUnitSchema),
  truncated: z.boolean(),
});

const artifactSchema = z.object({
  id: z.string(),
  kind: z.string(),
  status: z.string(),
  messageIndex: z.number().int().nullable(),
  coveredStartSeq: z.number().int(),
  coveredEndSeq: z.number().int(),
  error: z.string().nullable().optional(),
  stale: z.boolean(),
  staleBehindMessages: z.number().int(),
  outdated: z.boolean(),
  updatedAt: z.string(),
});
const artifactListSchema = z.array(artifactSchema);
const pendingResponseSchema = z.object({
  artifactId: z.string(),
  status: z.literal("pending"),
});
const artifactEnvelopeResponseSchema = z.object({
  artifact: artifactSchema,
  hint: z.string().optional(),
});

interface ConversationTarget {
  server: string;
  project: string;
  /** Null → project-scoped conversation (project-pathed endpoints). */
  session: string | null;
  token: string | null;
  tokenSource: TokenSource | null;
  conversationId: string;
  /** The invoking conversation's own id (env identity), for audit provenance. */
  callerConversationId: string | null;
}

/**
 * Resolve the target conversation: positional `<conversation-id>` first, then
 * `--conversation`, then `CC_CONVERSATION_ID` (reading your own history is
 * valid). Scope: an explicit `--project` without `--session` targets the
 * project-scoped paths; otherwise `--session`/`CC_SESSION` selects the
 * session-scoped paths.
 */
async function resolveConversationTarget(
  positional: string | undefined,
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  { ok: true; target: ConversationTarget } | { ok: false; result: CliResult }
> {
  const base = await resolveProjectContext(flags, env, host);
  if (!base.ok) return base;

  const conversationId =
    positional ?? flags.conversation ?? env["CC_CONVERSATION_ID"];
  if (!conversationId) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message:
          "no conversation — pass <conversation-id>, --conversation, or set CC_CONVERSATION_ID",
        json: flags.json,
      }),
    };
  }

  const session =
    flags.session ?? (flags.project ? undefined : env["CC_SESSION"]) ?? null;

  return {
    ok: true,
    target: {
      ...base.context,
      session,
      conversationId,
      callerConversationId: env["CC_CONVERSATION_ID"] ?? null,
    },
  };
}

function conversationBasePath(target: ConversationTarget): string {
  const project = encodePathSegment(target.project);
  const conversation = encodePathSegment(target.conversationId);
  return target.session === null
    ? `/api/projects/${project}/conversations/${conversation}`
    : `/api/projects/${project}/sessions/${encodePathSegment(target.session)}/conversations/${conversation}`;
}

function artifactsPath(target: ConversationTarget): string {
  return `${conversationBasePath(target)}/context-artifacts`;
}

function callerHeaders(
  target: ConversationTarget,
): Record<string, string> | undefined {
  return target.callerConversationId === null
    ? undefined
    : { [CALLER_CONVERSATION_HEADER]: target.callerConversationId };
}

function compactCommand(
  target: ConversationTarget,
  messageIndex?: number,
): string {
  const message =
    messageIndex === undefined ? "" : ` --message ${messageIndex}`;
  return `cctl conversation compact ${target.conversationId}${message}`;
}

/**
 * Map a failed request per the conversation-group contract: 404s are
 * disambiguated by the body `code` (both flavors are HTTP 404) — an absent
 * artifact is a real "no" (exit 1) with a create hint, while an unknown
 * conversation/project/session is a caller mistake (exit 2).
 */
function artifactRequestFailure(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
  absentHint: string,
): CliResult {
  if (
    result.kind === "error" &&
    result.status === 404 &&
    result.code === "artifact_not_found"
  ) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: result.error,
      hint: absentHint,
      json,
    });
  }
  return failureFromRequestNotFoundAsUsage(result, json);
}

/**
 * A verb body that reached a scope miss: its first scoped request 404'd because
 * the conversation does not live in the target's project/session. `fallback` is
 * the CliResult to surface if scope resolution can't find a better home (so the
 * caller still sees the server's original "not found").
 */
interface ScopeMiss {
  readonly scopeMiss: true;
  readonly fallback: CliResult;
}

function scopeMiss(fallback: CliResult): ScopeMiss {
  return { scopeMiss: true, fallback };
}

function isScopeMiss(value: CliResult | ScopeMiss): value is ScopeMiss {
  return "scopeMiss" in value && value.scopeMiss === true;
}

/**
 * A 404 that means "this conversation isn't in *this* scope" (as opposed to an
 * absent artifact or a bad request) — the signal to resolve the conversation's
 * real owning project/session by id and retry there.
 */
function isWrongScope404(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
): boolean {
  return (
    result.kind === "error" &&
    result.status === 404 &&
    (result.code === "conversation_not_found" ||
      result.error === "Session not found" ||
      result.error === "Project not found")
  );
}

/**
 * Auto-resolution applies only when the caller left scope implicit: an explicit
 * `--project`/`--session` is an override to respect, and the caller's own
 * conversation was already tried in its own scope (re-resolving yields the same
 * scope).
 */
function shouldAutoResolveScope(
  target: ConversationTarget,
  flags: GlobalFlags,
): boolean {
  if (flags.session !== undefined || flags.project !== undefined) return false;
  return target.conversationId !== target.callerConversationId;
}

/** Subset of the global-lookup ConversationListItem the CLI needs to re-scope. */
const conversationScopeSchema = z.object({
  projectName: z.string().min(1),
  sessionName: z.string().min(1),
});

type ScopeResolution =
  | { kind: "resolved"; projectName: string; sessionName: string }
  | { kind: "not-found" }
  | { kind: "error"; result: CliResult };

/**
 * Resolve a conversation's owning project + session by id alone via the global
 * lookup endpoint (`GET /api/conversations/<id>`), so a cross-session/-project
 * reference can be read without the caller knowing where it lives.
 */
async function resolveOwningScope(
  host: CliHost,
  target: ConversationTarget,
  json: boolean,
): Promise<ScopeResolution> {
  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: `/api/conversations/${encodePathSegment(target.conversationId)}`,
  });
  if (result.kind === "ok") {
    const parsed = conversationScopeSchema.safeParse(result.body);
    if (!parsed.success) {
      return {
        kind: "error",
        result: failure({
          exitCode: EXIT_OPERATION_FAILED,
          message:
            "could not resolve the conversation's project/session from the server",
          json,
        }),
      };
    }
    return {
      kind: "resolved",
      projectName: parsed.data.projectName,
      sessionName: parsed.data.sessionName,
    };
  }
  if (result.kind === "error" && result.status === 404) {
    return { kind: "not-found" };
  }
  return { kind: "error", result: failureFromRequest(result, json) };
}

/**
 * Run a conversation verb's request body against the caller's own scope; on a
 * scope miss, resolve the conversation's real project/session by id and retry
 * once there. Own-history and explicitly-scoped calls skip resolution and keep
 * the original "not found". This is how `cctl conversation <verb> <id>` works on
 * any conversation-ref without `--project`/`--session`.
 */
async function withScopeResolution(
  host: CliHost,
  target: ConversationTarget,
  flags: GlobalFlags,
  json: boolean,
  body: (t: ConversationTarget) => Promise<CliResult | ScopeMiss>,
): Promise<CliResult> {
  const first = await body(target);
  if (!isScopeMiss(first)) return first;
  if (!shouldAutoResolveScope(target, flags)) return first.fallback;

  const scope = await resolveOwningScope(host, target, json);
  if (scope.kind === "not-found") return first.fallback;
  if (scope.kind === "error") return scope.result;

  const retried = await body({
    ...target,
    project: scope.projectName,
    session: scope.sessionName,
  });
  return isScopeMiss(retried) ? retried.fallback : retried;
}

export async function runConversation(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const sub = rest[0];
  if (sub === undefined) {
    return usageFailure(
      "conversation requires a subcommand: read, compact, or compaction",
      json,
    );
  }
  if (sub === "read") {
    return runConversationRead(rest.slice(1), flags, values, env, host);
  }
  if (sub === "compact") {
    return runConversationCompact(rest.slice(1), flags, values, env, host);
  }
  if (sub === "compaction") {
    const verb = rest[1];
    if (verb === "get") {
      return runCompactionGet(rest.slice(2), flags, values, env, host);
    }
    if (verb === "list") {
      return runCompactionList(rest.slice(2), flags, values, env, host);
    }
    return usageFailure(
      "conversation compaction requires a verb: get or list",
      json,
    );
  }
  return usageFailure(`unknown conversation subcommand "${sub}"`, json);
}

interface ParsedPositional {
  id: string | undefined;
  extra: boolean;
}

function takeConversationPositional(rest: string[]): ParsedPositional {
  return { id: rest[0], extra: rest.length > 1 };
}

async function runConversationRead(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(
    values,
    [
      "outline",
      "message",
      "message-range",
      "seq-range",
      "include-tools",
      "include-thinking",
      "search",
      "max-bytes",
      "format",
    ],
    json,
  );
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation read takes a single <conversation-id> argument",
      json,
    );
  }

  const format = values["format"] ?? "json";
  if (format !== "json" && format !== "markdown") {
    return usageFailure("--format must be json or markdown", json);
  }

  const resolved = await resolveConversationTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    readBody(target, values, format, host, json),
  );
}

async function readBody(
  target: ConversationTarget,
  values: Record<string, string>,
  format: "json" | "markdown",
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  // Kebab-case CLI flags map to the endpoint's camelCase query params; the
  // server owns validation (400 → exit 2 with per-issue lines).
  const query = new URLSearchParams();
  if (values["outline"] !== undefined) query.set("outline", "true");
  if (values["message"] !== undefined) query.set("message", values["message"]);
  if (values["message-range"] !== undefined)
    query.set("messageRange", values["message-range"]);
  if (values["seq-range"] !== undefined)
    query.set("seqRange", values["seq-range"]);
  if (values["include-tools"] !== undefined)
    query.set("includeTools", values["include-tools"]);
  if (values["include-thinking"] !== undefined)
    query.set("includeThinking", "true");
  if (values["search"] !== undefined) query.set("search", values["search"]);
  if (values["max-bytes"] !== undefined)
    query.set("maxBytes", values["max-bytes"]);
  if (format === "markdown") query.set("format", "markdown");

  const queryString = query.toString();
  const path = `${conversationBasePath(target)}/read${queryString === "" ? "" : `?${queryString}`}`;
  const requestParams = {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path,
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  };

  const outlineHint =
    values["outline"] !== undefined
      ? `narrow with --message-range or fetch the compaction: cctl conversation compaction get ${target.conversationId}`
      : undefined;

  if (format === "markdown") {
    const result = await cliRequestText(host, requestParams);
    if (result.kind !== "ok") {
      const failed = failureFromRequestNotFoundAsUsage(result, json);
      return isWrongScope404(result) ? scopeMiss(failed) : failed;
    }
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        result.text.endsWith("\n") ? result.text : `${result.text}\n`,
        {
          ok: true,
          markdown: result.text,
          ...(outlineHint ? { hint: outlineHint } : {}),
        },
      ),
      stderr: "",
    };
  }

  const result = await cliRequest(host, requestParams);
  if (result.kind !== "ok") {
    const failed = failureFromRequestNotFoundAsUsage(result, json);
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const parsed = readResponseSchema.safeParse(result.body);
  const humanBody = parsed.success
    ? renderTranscriptHuman(parsed.data)
    : `${JSON.stringify(result.body, null, 2)}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      transcript: result.body,
      ...(outlineHint ? { hint: outlineHint } : {}),
    }),
    stderr: "",
  };
}

function renderTranscriptHuman(
  transcript: z.infer<typeof readResponseSchema>,
): string {
  if (transcript.units.length === 0) {
    return transcript.truncated
      ? "no transcript units fit within --max-bytes (truncated — raise --max-bytes or narrow the window)\n"
      : "no matching transcript units\n";
  }
  const blocks = transcript.units.map((unit) => {
    const header = `#${unit.ref.messageIndex} [seq ${unit.ref.seqStart}-${unit.ref.seqEnd}] ${unit.role} ${unit.timestamp}`;
    return [header, ...unit.lines].join("\n");
  });
  const footer = transcript.truncated
    ? "\n(truncated at --max-bytes — narrow the window to see more)"
    : "";
  return `${blocks.join("\n\n")}${footer}\n`;
}

async function runConversationCompact(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, ["message", "force", "wait"], json);
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation compact takes a single <conversation-id> argument",
      json,
    );
  }

  const rawMessage = values["message"];
  if (rawMessage !== undefined && !INTEGER_PATTERN.test(rawMessage)) {
    return usageFailure("--message must be a non-negative integer", json);
  }
  const messageIndex =
    rawMessage === undefined ? undefined : Number(rawMessage);

  const resolved = await resolveConversationTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    compactBody(target, values, messageIndex, host, json),
  );
}

async function compactBody(
  target: ConversationTarget,
  values: Record<string, string>,
  messageIndex: number | undefined,
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "POST",
    path: artifactsPath(target),
    body: {
      kind:
        messageIndex === undefined
          ? "conversation_compaction"
          : "message_compaction",
      mode: "create_or_refresh",
      ...(messageIndex === undefined ? {} : { messageIndex }),
      ...(values["force"] !== undefined ? { force: true } : {}),
      ...(target.callerConversationId === null
        ? {}
        : { callerConversationId: target.callerConversationId }),
    },
  });

  if (result.kind !== "ok") {
    const failed = failureFromRequestNotFoundAsUsage(result, json);
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const fresh = artifactEnvelopeResponseSchema.safeParse(result.body);
  if (fresh.success) {
    // 200 — the artifact was already fresh (server-side coalescing / no-op).
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        `compaction already fresh (artifact ${fresh.data.artifact.id})\n`,
        {
          ok: true,
          artifact: extractArtifactBody(result.body),
          hint: fresh.data.hint ?? "already fresh",
        },
      ),
      stderr: "",
    };
  }

  const pending = pendingResponseSchema.safeParse(result.body);
  if (!pending.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected compaction response from the server",
      json,
    });
  }

  if (values["wait"] === undefined) {
    return {
      exitCode: EXIT_OK,
      stdout: render(
        json,
        `compaction started (artifact ${pending.data.artifactId})\n`,
        {
          ok: true,
          artifactId: pending.data.artifactId,
          status: "pending",
          hint: `check status with: cctl conversation compaction get ${target.conversationId}${messageIndex === undefined ? "" : ` --message ${messageIndex}`}`,
        },
      ),
      stderr: "",
    };
  }

  return awaitArtifact(
    host,
    target,
    pending.data.artifactId,
    json,
    messageIndex,
  );
}

/** Poll the artifact until it leaves `pending` (bounded; instant in tests via host.sleep). */
async function awaitArtifact(
  host: CliHost,
  target: ConversationTarget,
  artifactId: string,
  json: boolean,
  messageIndex: number | undefined,
): Promise<CliResult> {
  const path = `${artifactsPath(target)}/${encodePathSegment(artifactId)}`;
  const absentHint = `create with: ${compactCommand(target, messageIndex)}`;

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await host.sleep(POLL_INTERVAL_MS);

    const result = await cliRequest(host, {
      server: target.server,
      token: target.token,
      tokenSource: target.tokenSource,
      method: "GET",
      path,
    });
    if (result.kind !== "ok") {
      return artifactRequestFailure(result, json, absentHint);
    }

    const parsed = artifactSchema.safeParse(result.body);
    if (!parsed.success) {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "unexpected artifact response from the server",
        json,
      });
    }
    if (parsed.data.status === "pending") continue;

    if (parsed.data.status === "failed") {
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `compaction failed: ${parsed.data.error ?? "unknown error"}`,
        hint: `retry with: ${compactCommand(target, messageIndex)}`,
        json,
      });
    }
    return {
      exitCode: EXIT_OK,
      stdout: render(json, artifactSummaryLine(parsed.data, target), {
        ok: true,
        artifact: result.body,
      }),
      stderr: "",
    };
  }

  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message: `timed out waiting for compaction (artifact ${artifactId})`,
    hint: `check later with: cctl conversation compaction get ${target.conversationId}${messageIndex === undefined ? "" : ` --message ${messageIndex}`}`,
    json,
  });
}

function extractArtifactBody(body: unknown): unknown {
  return body && typeof body === "object" && "artifact" in body
    ? (body as { artifact: unknown }).artifact
    : body;
}

function artifactSummaryLine(
  artifact: z.infer<typeof artifactSchema>,
  target: ConversationTarget,
): string {
  const freshness = artifact.outdated
    ? "outdated"
    : artifact.stale
      ? `stale (behind ${artifact.staleBehindMessages})`
      : "fresh";
  const message =
    artifact.messageIndex === null ? "" : ` message=${artifact.messageIndex}`;
  return `artifact ${artifact.id} ${artifact.kind}${message} status=${artifact.status} covered=${artifact.coveredStartSeq}..${artifact.coveredEndSeq} ${freshness} (conversation ${target.conversationId})\n`;
}

async function runCompactionGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, ["message"], json);
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation compaction get takes a single <conversation-id> argument",
      json,
    );
  }

  const rawMessage = values["message"];
  if (rawMessage !== undefined && !INTEGER_PATTERN.test(rawMessage)) {
    return usageFailure("--message must be a non-negative integer", json);
  }
  const messageIndex =
    rawMessage === undefined ? undefined : Number(rawMessage);

  const resolved = await resolveConversationTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    compactionGetBody(target, messageIndex, host, json),
  );
}

async function compactionGetBody(
  target: ConversationTarget,
  messageIndex: number | undefined,
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const absentHint = `create with: ${compactCommand(target, messageIndex)}`;

  const listResult = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: artifactsPath(target),
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  });
  if (listResult.kind !== "ok") {
    const failed = artifactRequestFailure(listResult, json, absentHint);
    return isWrongScope404(listResult) ? scopeMiss(failed) : failed;
  }

  const listed = artifactListSchema.safeParse(listResult.body);
  const rows = listed.success ? listed.data : [];
  const wantedKind =
    messageIndex === undefined
      ? "conversation_compaction"
      : "message_compaction";
  const candidates = rows
    .filter(
      (row) =>
        row.kind === wantedKind &&
        (messageIndex === undefined || row.messageIndex === messageIndex),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const chosen = candidates[0];
  if (chosen === undefined) {
    const what =
      messageIndex === undefined
        ? "no conversation compaction"
        : `no compaction for message ${messageIndex}`;
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `${what} for conversation ${target.conversationId}`,
      hint: absentHint,
      json,
    });
  }

  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: `${artifactsPath(target)}/${encodePathSegment(chosen.id)}`,
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  });
  if (result.kind !== "ok") {
    return artifactRequestFailure(result, json, absentHint);
  }

  const parsed = artifactSchema.safeParse(result.body);
  const hint = !parsed.success
    ? undefined
    : parsed.data.status === "failed"
      ? `retry with: ${compactCommand(target, messageIndex)}`
      : parsed.data.stale || parsed.data.outdated
        ? `refresh with: ${compactCommand(target, messageIndex)}`
        : undefined;

  const payload =
    result.body && typeof result.body === "object" && "payload" in result.body
      ? (result.body as { payload: unknown }).payload
      : null;
  const humanBody = parsed.success
    ? `${artifactSummaryLine(parsed.data, target)}${payload === null ? "" : `${JSON.stringify(payload, null, 2)}\n`}`
    : `${JSON.stringify(result.body, null, 2)}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      artifact: result.body,
      ...(hint ? { hint } : {}),
    }),
    stderr: "",
  };
}

async function runCompactionList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;

  const denied = checkFlags(values, [], json);
  if (denied) return denied;

  const { id, extra } = takeConversationPositional(rest);
  if (extra) {
    return usageFailure(
      "conversation compaction list takes a single <conversation-id> argument",
      json,
    );
  }

  const resolved = await resolveConversationTarget(id, flags, env, host);
  if (!resolved.ok) return resolved.result;

  return withScopeResolution(host, resolved.target, flags, json, (target) =>
    compactionListBody(target, host, json),
  );
}

async function compactionListBody(
  target: ConversationTarget,
  host: CliHost,
  json: boolean,
): Promise<CliResult | ScopeMiss> {
  const result = await cliRequest(host, {
    server: target.server,
    token: target.token,
    tokenSource: target.tokenSource,
    method: "GET",
    path: artifactsPath(target),
    ...(callerHeaders(target) ? { headers: callerHeaders(target) } : {}),
  });
  if (result.kind !== "ok") {
    const failed = failureFromRequestNotFoundAsUsage(result, json);
    return isWrongScope404(result) ? scopeMiss(failed) : failed;
  }

  const parsed = artifactListSchema.safeParse(result.body);
  const rows = parsed.success ? parsed.data : [];
  const humanBody =
    rows.length === 0
      ? `no compaction artifacts for conversation ${target.conversationId}\n`
      : `${rows.map((row) => artifactSummaryLine(row, target).trimEnd()).join("\n")}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanBody, {
      ok: true,
      artifacts: result.body,
      hint: `fetch the full envelope with: cctl conversation compaction get ${target.conversationId}; create one with: ${compactCommand(target)}`,
    }),
    stderr: "",
  };
}
