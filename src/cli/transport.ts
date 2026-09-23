import path from "node:path";
import {
  BUILD_MISMATCH_HEADER,
  BUILD_SKEW_CODE,
  parseBuildMismatchHeader,
} from "@/lib/agent-gateway/build-parity";
import { BUILD_INFO } from "@/lib/build-info/build-info.generated";
import { formatBuildStamp } from "@/lib/build-info/stamp-value";
import { resolveConfigDirFrom } from "@/lib/config/config-dir";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  CONVERSATION_IDENTITY_ENV_VAR,
  CONVERSATION_IDENTITY_HEADER,
  encodeConversationIdentity,
} from "@/lib/agent-gateway/conversation-identity";
import {
  LANE_IDENTITY_HEADER,
  encodeLaneIdentity,
} from "@/lib/agent-gateway/lane-identity";
const logger = createLogger("cli.shared");

export type CliEnv = Record<string, string | undefined>;

export interface CliPrincipalIdentity {
  conversation?: string;
  lane?: string;
}

/** Caller identity comes only from the environment, independently of CLI target flags. */
export function resolveCliPrincipalIdentity(env: CliEnv): CliPrincipalIdentity {
  const conversationId = env[CONVERSATION_IDENTITY_ENV_VAR];
  const sessionName = readSessionEnv(env);
  const executionId = env["CC_WORKFLOW_EXECUTION_ID"];
  const contextId = env["CC_WORKFLOW_CONTEXT_ID"];
  const laneConversationId = env["CC_CONVERSATION_ID"];
  if (executionId || contextId) {
    return {
      lane: encodeLaneIdentity({
        laneKind: "implementer",
        executionId: executionId ?? "",
        contextId: contextId ?? "",
        conversationId: laneConversationId ?? "",
      }),
    };
  }
  return conversationId && sessionName
    ? {
        conversation: encodeConversationIdentity({
          sessionName,
          conversationId,
        }),
      }
    : {};
}

/**
 * Request init the CLI hands to its injected fetch. `body` is optional so the
 * same seam serves GET (no body) and POST/DELETE (JSON body); native `fetch`
 * and `new Request(url, init)` both accept this shape.
 */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /**
   * Binary request body (e.g. a multipart file upload). Wins over `body` when
   * both are set; hosts pass it to fetch verbatim. A separate field (rather
   * than widening `body`) so existing string-body assertions and hosts stay
   * untouched.
   */
  rawBody?: Uint8Array<ArrayBuffer>;
  /**
   * Optional per-request timeout in ms. The real host (`index.ts`) maps it to
   * `AbortSignal.timeout`; injected test hosts can inspect or emulate it. Used
   * by best-effort help context and bounded polling so neither operation can
   * stall beyond its caller-owned budget.
   */
  timeoutMs?: number;
  /** Allow owned cleanup after interruption, with its own deadline (1–5000ms). */
  cleanupTimeoutMs?: number;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

/**
 * Everything the CLI touches outside its own arguments: HTTP, the token
 * file, and the OS facts needed to locate the config dir. Injected so the
 * whole command surface is testable without a server or filesystem.
 */
export interface CliHost {
  /** Observe decoded authenticated JSON before domain schemas select response fields. */
  onJsonResponse?(body: unknown): void;
  fetch: FetchLike;
  /** Read a text file, or null when it does not exist / is unreadable. */
  readTextFile(filePath: string): Promise<string | null>;
  /**
   * Read a file's raw bytes (binary-safe, e.g. ticket file attachments), or
   * null when it does not exist / is unreadable.
   */
  readFileBytes(filePath: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Persist a secret-bearing UTF-8 file with owner-only permissions. */
  writePrivateTextFile?(filePath: string, content: string): Promise<void>;
  /** Remove one exact file path; implementations ignore an absent file. */
  removeFile?(filePath: string): Promise<void>;
  /**
   * Pause for `ms` milliseconds. Injected so polling commands (e.g. `dev
   * ensure`, which blocks until liveness) stay pure — tests supply an instant
   * fake so the loop advances without real time.
   */
  sleep(ms: number): Promise<void>;
  /** Current wall-clock milliseconds for bounded polling; defaults to Date.now. */
  now?(): number;
  platform: string;
  homedir: string;
}

export type TokenSource = "flag" | "env" | "file";

export interface ResolvedToken {
  token: string | null;
  source: TokenSource | null;
}

/** Resolution order per doc 01 §2: flags > env vars > <configDir>/api-token. */
export async function resolveToken(
  flags: { readonly token?: string },
  env: CliEnv,
  host: CliHost,
): Promise<ResolvedToken> {
  if (flags.token) return { token: flags.token, source: "flag" };
  const fromEnv = env["CC_API_TOKEN"];
  if (fromEnv) return { token: fromEnv, source: "env" };

  const configDir = resolveConfigDirFrom(env, host);
  const raw = await host.readTextFile(path.join(configDir, "api-token"));
  const token = raw?.trim() ?? "";
  if (token) return { token, source: "file" };
  return { token: null, source: null };
}

/** Resolved project identity + token, shared by every project-scoped command. */
export interface ProjectContext {
  server: string;
  project: string;
  token: string | null;
  tokenSource: TokenSource | null;
}

/** Resolved session identity + token, shared by every session-scoped command. */
export interface SessionContext extends ProjectContext {
  session: string;
}

/** Resolved session + conversation identity, for conversation-scoped commands. */
export interface ConversationContext extends SessionContext {
  conversation: string;
}

/**
 * Resolved server + project + authoring conversation id, session-agnostic.
 */
export interface ProjectConversationContext extends ProjectContext {
  conversation: string;
}

/**
 * Resolved server + project + a scope-discriminated conversation target, for
 * the project-supported commands. The target — not a nullable session name —
 * is what makes an empty or sentinel session segment unspellable.
 */
export interface ConversationTargetContext extends ProjectContext {
  target: ConversationTarget;
}

/**
 * Resolved session + graph-workflow lane identity, for the `cctl workflow`
 * lane verbs (task complete/add, shared-doc upsert, collab request). The lane's
 * execution + context come from the env CC injects at spawn
 * (`CC_WORKFLOW_EXECUTION_ID` / `CC_WORKFLOW_CONTEXT_ID`, doc 01 §2) — there is
 * no flag override; these identify the one lane the conversation runs.
 */
export interface LaneContext extends SessionContext {
  executionId: string;
  contextId: string;
}

/**
 * The session identity from the env, treated as ABSENT when empty.
 *
 * A project conversation's env carries `CC_SESSION=""` — present so it cannot
 * resurrect the ambient value through the contract's env merge, empty so it is
 * not an identity. Every env session read must be this falsy check and never
 * `env["CC_SESSION"] ?? fallback`: `??` passes "" straight through and builds a
 * URL with an empty session segment (`/sessions//conversations/…`), which is the
 * silent misrouting the neutralization exists to prevent.
 */
export function readSessionEnv(env: CliEnv): string | null {
  const session = env["CC_SESSION"];
  return session === undefined || session === "" ? null : session;
}

/**
 * The conversation scope the agent environment declares (`CC_CONVERSATION_SCOPE`,
 * D3). Read explicitly rather than inferred from the shape of `CC_SESSION`, and
 * null when the var is absent or unrecognised (an older env, or a human shell)
 * so callers fall back to the session identity.
 */
export function readConversationScope(
  env: CliEnv,
): "session" | "project" | null {
  const scope = env["CC_CONVERSATION_SCOPE"];
  return scope === "session" || scope === "project" ? scope : null;
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

export interface RequestIssue {
  path: string;
  message: string;
  /**
   * The id of the record `path` addresses, when the server names one (#80
   * design 3.2). JSON-envelope only: the text line already carries the id
   * inside `path`, so printing it twice would say the same thing twice.
   */
  recordId?: string;
}

/** Build parity refuses mutations before dispatch and discards mismatched reads. */
export { BUILD_SKEW_CODE };

export interface BuildSkewCliErrorDetails {
  serverBuild: string;
  /** The cctl that server publishes, or null when it has not installed one. */
  serverCliPath: string | null;
}

export interface LintBlockedCliErrorDetails {
  findings: unknown[];
}

export interface StaleElementCliErrorDetails {
  currentContent: unknown;
  currentVersion: number;
}

/**
 * Shared structured failure context. `code` on the containing result/envelope
 * discriminates the two V1 SDD shapes; other command families retain their
 * additive record-shaped details without a family-specific adapter.
 */
export type CliErrorDetails =
  | BuildSkewCliErrorDetails
  | LintBlockedCliErrorDetails
  | StaleElementCliErrorDetails
  | Record<string, unknown>;

export type CliRequestResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "invalid_request"; detail: string }
  | { kind: "connection"; detail: string }
  | { kind: "auth"; hadToken: boolean; tokenSource: TokenSource | null }
  | {
      kind: "version_mismatch";
      serverBuild: string;
      cliBuild: string;
    }
  | {
      kind: "error";
      status: number;
      error: string;
      issues?: RequestIssue[];
      /** Machine-readable error code when the endpoint supplies one (e.g. `NO_DEV_SERVERS_CONFIGURED`). */
      code?: string;
      /** Tier-2 invariants the server attaches to an error (e.g. lane halt 409s). */
      reminders?: string[];
      /** Tier-3 server-authored next step for a refused operation. */
      instruction?: string;
      /** The refusal's own reason for existing, when the server states one. */
      rationale?: string;
      /** Code-discriminated structured context for the refusal. */
      details?: CliErrorDetails;
    };

export interface CliRequestParams {
  server: string;
  token: string | null;
  tokenSource: TokenSource | null;
  method: string;
  path: string;
  body?: unknown;
  /**
   * Pre-encoded binary body (e.g. multipart form data). Sent verbatim — the
   * caller must supply the matching `content-type` via `headers`. Wins over
   * `body`.
   */
  rawBody?: Uint8Array<ArrayBuffer>;
  /** Extra request headers (e.g. the caller-conversation audit header). */
  headers?: Record<string, string>;
  /** Environment-derived caller identity, independent of target flags. */
  principalIdentity?: CliPrincipalIdentity;
  /** Bound the complete HTTP operation; the real host aborts at this deadline. */
  timeoutMs?: number;
  /** Allow owned cleanup after interruption, with its own deadline (1–5000ms). */
  cleanupTimeoutMs?: number;
  /**
   * Send no build stamp, so the server's parity gate reads this as an ordinary
   * API client — the browser, curl, an internal fetch — rather than as its own
   * published cctl.
   *
   * The gate asks "is this binary the command surface THIS server published",
   * which is the right question for every verb that drives the one CC instance
   * owning the caller's session. `fixture` is the exception it cannot answer:
   * it deliberately addresses a SECOND instance (a worktree dev server), which
   * runs the branch while the binary comes from the installed build, so the two
   * differ by construction and no binary satisfies both hops. There the gate
   * forbids the command's purpose instead of protecting anything. Confined to
   * callers that use only the plain project/session/conversation REST surface
   * the browser already drives, and whose every response is schema-parsed.
   */
  unstamped?: boolean;
}

function coerceIssues(value: unknown): RequestIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: RequestIssue[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object") {
      const path = (entry as { path?: unknown }).path;
      const message = (entry as { message?: unknown }).message;
      const recordId = (entry as { recordId?: unknown }).recordId;
      issues.push({
        path: typeof path === "string" ? path : String(path ?? ""),
        message: typeof message === "string" ? message : String(message ?? ""),
        ...(typeof recordId === "string" ? { recordId } : {}),
      });
    }
  }
  return issues.length > 0 ? issues : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceUnmetConditions(value: unknown): RequestIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues = value.flatMap((condition, index) =>
    typeof condition === "string"
      ? [{ path: `unmetConditions[${index}]`, message: condition }]
      : [],
  );
  return issues.length > 0 ? issues : undefined;
}

function coerceGuidanceText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function coerceErrorDetails(
  body: Record<string, unknown>,
  code: string | undefined,
): CliErrorDetails | undefined {
  const rawDetails = isRecord(body.details) ? body.details : undefined;

  if (
    code === "definition_approval_required" &&
    typeof body.executionId === "string" &&
    body.executionId.trim().length > 0
  ) {
    return {
      ...(rawDetails ?? {}),
      executionId: body.executionId,
    };
  }

  if (code === "lint_blocked") {
    const findings = Array.isArray(body.findings)
      ? body.findings
      : rawDetails && Array.isArray(rawDetails.findings)
        ? rawDetails.findings
        : undefined;
    if (findings) return { findings };
  }

  if (code === "stale_element") {
    const current = isRecord(body.current)
      ? body.current
      : rawDetails && isRecord(rawDetails.current)
        ? rawDetails.current
        : undefined;
    const currentContent =
      rawDetails?.currentContent ?? current?.currentContent ?? current?.payload;
    const currentVersion =
      rawDetails?.currentVersion ??
      current?.currentVersion ??
      current?.elementVersion;
    if (currentContent !== undefined && typeof currentVersion === "number") {
      return { currentContent, currentVersion };
    }
  }

  // A typed lifecycle refusal states more than its code: which operation it is
  // about, the phase that operation actually holds, and — for a repair that
  // could only finish half its work — the receipt carrying the correlated
  // attempt. A command that had to re-read the raw body for those would be
  // parsing a response the transport already classified, so they are folded in
  // here as ordinary details rather than special-cased per command.
  const refusal = isRecord(body.refusal) ? body.refusal : undefined;
  const receipt = isRecord(body.receipt) ? body.receipt : undefined;
  if (refusal !== undefined || receipt !== undefined) {
    return {
      ...(rawDetails ?? {}),
      ...(refusal ? { refusal } : {}),
      ...(receipt ? { receipt } : {}),
    };
  }

  return rawDetails;
}

function coerceReminders(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const reminders = value.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return reminders.length > 0 ? reminders : undefined;
}

function buildRequestInit(params: CliRequestParams): FetchInit {
  const headers: Record<string, string> = {
    ...(params.unstamped === true
      ? {}
      : { "x-cc-cli-build": formatBuildStamp(BUILD_INFO) }),
    "content-type": "application/json",
    ...(params.headers ?? {}),
    ...(params.principalIdentity?.conversation
      ? {
          [CONVERSATION_IDENTITY_HEADER]: params.principalIdentity.conversation,
        }
      : {}),
    ...(params.principalIdentity?.lane
      ? { [LANE_IDENTITY_HEADER]: params.principalIdentity.lane }
      : {}),
  };
  if (params.token !== null)
    headers["authorization"] = `Bearer ${params.token}`;

  const init: FetchInit = { method: params.method, headers };
  if (params.timeoutMs !== undefined) init.timeoutMs = params.timeoutMs;
  if (params.cleanupTimeoutMs !== undefined)
    init.cleanupTimeoutMs = params.cleanupTimeoutMs;
  if (params.rawBody !== undefined) init.rawBody = params.rawBody;
  else if (params.body !== undefined) init.body = JSON.stringify(params.body);
  return init;
}

/** Only failures before fetch prove that a write was never submitted. */
async function submitRequest(
  host: CliHost,
  params: CliRequestParams,
): Promise<
  | { kind: "response"; response: Response }
  | Extract<CliRequestResult, { kind: "invalid_request" | "connection" }>
> {
  let url: URL;
  let init: FetchInit;
  try {
    url = new URL(params.path, params.server);
    init = buildRequestInit(params);
  } catch (error) {
    const detail = getErrorMessage(error);
    return {
      kind: "invalid_request",
      detail: params.token
        ? detail.replaceAll(params.token, "[redacted]")
        : detail,
    };
  }
  try {
    // Validate before fetch obscures whether a request was submitted, keeping
    // the caller's header spelling on the wire. Native errors can quote a
    // normalized Authorization value, so do not expose their exception text.
    new Headers(init.headers);
  } catch {
    return {
      kind: "invalid_request",
      detail: "Request headers contain an invalid name or value.",
    };
  }
  try {
    return {
      kind: "response",
      response: await host.fetch(url.toString(), init),
    };
  } catch (error) {
    return { kind: "connection", detail: getErrorMessage(error) };
  }
}

function classifyErrorBody(
  status: number,
  body: unknown,
): Extract<CliRequestResult, { kind: "error" }> {
  const bodyRecord = isRecord(body) ? body : undefined;
  const firstUnmetCondition =
    bodyRecord &&
    Array.isArray(bodyRecord.unmetConditions) &&
    typeof bodyRecord.unmetConditions[0] === "string"
      ? bodyRecord.unmetConditions[0]
      : undefined;
  const errorMessage =
    bodyRecord && typeof bodyRecord.error === "string"
      ? bodyRecord.error
      : (firstUnmetCondition ?? `server responded with HTTP ${status}`);
  const issues = bodyRecord
    ? (coerceIssues(bodyRecord.issues) ??
      coerceUnmetConditions(bodyRecord.unmetConditions))
    : undefined;
  const code =
    body &&
    typeof body === "object" &&
    typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : undefined;
  const reminders = bodyRecord
    ? coerceReminders(bodyRecord.reminders)
    : undefined;
  const instruction = bodyRecord
    ? coerceGuidanceText(bodyRecord.instruction)
    : undefined;
  const rationale = bodyRecord
    ? coerceGuidanceText(bodyRecord.rationale)
    : undefined;
  const details = bodyRecord ? coerceErrorDetails(bodyRecord, code) : undefined;
  logger.debug("cli.error_classified", {
    status,
    code: code ?? null,
    issueCount: issues?.length ?? 0,
    hasInstruction: instruction !== undefined,
    hasDetails: details !== undefined,
  });
  return {
    kind: "error",
    status,
    error: errorMessage,
    ...(issues ? { issues } : {}),
    ...(code ? { code } : {}),
    ...(reminders ? { reminders } : {}),
    ...(instruction ? { instruction } : {}),
    ...(rationale ? { rationale } : {}),
    ...(details ? { details } : {}),
  };
}

/**
 * The build skew this response reports, or null when the binary and the server
 * agree. Every CC server publishes its own `cctl`, so skew means this binary
 * belongs to a different server than the one being addressed — its command
 * surface and the state it is reading come from different trees.
 */
function readBuildMismatch(
  response: Response,
): Extract<CliRequestResult, { kind: "version_mismatch" }> | null {
  const header = response.headers.get(BUILD_MISMATCH_HEADER);
  if (header === null) return null;
  const parsed = parseBuildMismatchHeader(header);
  if (parsed === null) return null;
  return { kind: "version_mismatch", ...parsed };
}

/**
 * Issue a token-authenticated request to a CC agent endpoint and classify the
 * response into the shared discriminated result. Sends the build header and a
 * JSON content-type; attaches the bearer token when present.
 */
export async function cliRequest(
  host: CliHost,
  params: CliRequestParams,
): Promise<CliRequestResult> {
  if (params.principalIdentity !== undefined) {
    logger.debug("cli.request_principal_attached", {
      method: params.method,
      path: params.path,
      hasConversationCapability:
        params.principalIdentity.conversation !== undefined,
      hasLaneCapability: params.principalIdentity.lane !== undefined,
    });
  }

  const submitted = await submitRequest(host, params);
  if (submitted.kind !== "response") return submitted;
  const { response } = submitted;

  if (response.status === 401) {
    return {
      kind: "auth",
      hadToken: params.token !== null,
      tokenSource: params.tokenSource,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok) {
    const skew = readBuildMismatch(response);
    if (skew !== null) return skew;
    host.onJsonResponse?.(body);
    return { kind: "ok", status: response.status, body };
  }

  host.onJsonResponse?.(body);
  return classifySkewedErrorBody(response, body);
}

/**
 * Classify a non-2xx body, preferring the server's own skew refusal over the
 * mismatch header carried by the same response: the refusal is authoritative
 * about what happened (nothing ran) and names the recovery binary, while the
 * header only reports the stamps.
 */
function classifySkewedErrorBody(
  response: Response,
  body: unknown,
): Exclude<CliRequestResult, { kind: "ok" }> {
  const classified = classifyErrorBody(response.status, body);
  if (classified.code === BUILD_SKEW_CODE) return classified;
  return readBuildMismatch(response) ?? classified;
}

export type CliStreamRequestResult =
  | { kind: "ok"; status: number; response: Response }
  | Exclude<CliRequestResult, { kind: "ok" }>;

/** Keep a successful stream unread; callers own incremental consumption and cancellation. */
export async function cliRequestStream(
  host: CliHost,
  params: CliRequestParams,
): Promise<CliStreamRequestResult> {
  const submitted = await submitRequest(host, params);
  if (submitted.kind !== "response") return submitted;
  const { response } = submitted;
  if (response.status === 401) {
    await response.body?.cancel().catch(() => {});
    return {
      kind: "auth",
      hadToken: params.token !== null,
      tokenSource: params.tokenSource,
    };
  }
  if (response.ok) {
    const skew = readBuildMismatch(response);
    if (skew !== null) {
      await response.body?.cancel().catch(() => {});
      return skew;
    }
    return { kind: "ok", status: response.status, response };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  host.onJsonResponse?.(body);
  return classifySkewedErrorBody(response, body);
}

export type CliTextRequestResult =
  | { kind: "ok"; status: number; text: string }
  | Exclude<CliRequestResult, { kind: "ok" }>;

/**
 * Like {@link cliRequest} for endpoints whose success body is plain text
 * (e.g. `?format=markdown` transcript reads). Non-2xx bodies are still parsed
 * as JSON so error classification matches the JSON path.
 */
export async function cliRequestText(
  host: CliHost,
  params: CliRequestParams,
): Promise<CliTextRequestResult> {
  const submitted = await submitRequest(host, params);
  if (submitted.kind !== "response") return submitted;
  const { response } = submitted;

  if (response.status === 401) {
    return {
      kind: "auth",
      hadToken: params.token !== null,
      tokenSource: params.tokenSource,
    };
  }

  const text = await response.text();
  if (response.ok) {
    const skew = readBuildMismatch(response);
    if (skew !== null) return skew;
    return { kind: "ok", status: response.status, text };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  host.onJsonResponse?.(body);
  return classifySkewedErrorBody(response, body);
}

export type CliBytesRequestResult =
  | {
      kind: "ok";
      status: number;
      bytes: Uint8Array<ArrayBuffer>;
      /** The response's own `content-type`, which names what the bytes are. */
      mediaType: string;
    }
  | Exclude<CliRequestResult, { kind: "ok" }>;

/**
 * Like {@link cliRequest} for an endpoint whose success body is BINARY (an
 * archived image). Decoding those bytes as UTF-8 to parse them as JSON would
 * corrupt them, so the success arm keeps them as bytes; a non-2xx body is still
 * read as text and classified exactly as the JSON path classifies it, so a
 * refusal keeps its code, issues and exit class.
 */
export async function cliRequestBytes(
  host: CliHost,
  params: CliRequestParams,
): Promise<CliBytesRequestResult> {
  const submitted = await submitRequest(host, params);
  if (submitted.kind !== "response") return submitted;
  const { response } = submitted;

  if (response.status === 401) {
    return {
      kind: "auth",
      hadToken: params.token !== null,
      tokenSource: params.tokenSource,
    };
  }

  if (response.ok) {
    const skew = readBuildMismatch(response);
    if (skew !== null) return skew;
    const buffer = await response.arrayBuffer();
    return {
      kind: "ok",
      status: response.status,
      bytes: new Uint8Array(buffer),
      mediaType:
        response.headers.get("content-type") ?? "application/octet-stream",
    };
  }

  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  host.onJsonResponse?.(body);
  return classifySkewedErrorBody(response, body);
}
