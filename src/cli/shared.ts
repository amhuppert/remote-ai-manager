import path from "node:path";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { resolveConfigDirFrom } from "@/lib/config/config-dir";

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Environment as the CLI sees it — a plain record so tests inject it directly. */
export type CliEnv = Record<string, string | undefined>;

/**
 * Request init the CLI hands to its injected fetch. `body` is optional so the
 * same seam serves GET (no body) and POST/DELETE (JSON body); native `fetch`
 * and `new Request(url, init)` both accept this shape.
 */
export interface FetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

/**
 * Everything the CLI touches outside its own arguments: HTTP, the token
 * file, and the OS facts needed to locate the config dir. Injected so the
 * whole command surface is testable without a server or filesystem.
 */
export interface CliHost {
  fetch: FetchLike;
  /** Read a text file, or null when it does not exist / is unreadable. */
  readTextFile(filePath: string): Promise<string | null>;
  /**
   * Pause for `ms` milliseconds. Injected so polling commands (e.g. `dev
   * ensure`, which blocks until liveness) stay pure — tests supply an instant
   * fake so the loop advances without real time.
   */
  sleep(ms: number): Promise<void>;
  platform: string;
  homedir: string;
}

// Exit codes per docs/design/cc-cli/01 §6.
export const EXIT_OK = 0;
export const EXIT_OPERATION_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONNECTION = 3;
/** Reserved for a hard version-mismatch policy; mismatches today warn on stderr only. */
export const EXIT_VERSION_MISMATCH = 4;

export const USAGE = `usage: cctl <command> [flags]

commands:
  ask           ask the user a question batch, then end your turn
  notify        send a push notification to the user
  docs          register, list, and delete reference documents
  dev           list, ensure, and stop dev servers
  workflow      list, inspect, start, and delete graph workflows
  charter       submit the session's Alignment charter
  decisions     propose decisions for the user's review
  codex         run, poll, and cancel one-shot Codex jobs
  conversation  read conversation transcripts and manage compaction artifacts
  doctor        check connectivity, auth, and build parity with the CC server
  version       print the cctl build stamp

global flags:
  --server <url>         CC server base URL (default: $CC_SERVER_URL)
  --token <token>        API token (default: $CC_API_TOKEN, then <configDir>/api-token)
  --project <name>       project identity (default: $CC_PROJECT)
  --session <name>       session identity (default: $CC_SESSION)
  --conversation <id>    conversation identity (default: $CC_CONVERSATION_ID)
  --json                 structured output envelope
`;

const VALUE_FLAGS = [
  "server",
  "token",
  "project",
  "session",
  "conversation",
] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];

export interface GlobalFlags extends Partial<Record<ValueFlag, string>> {
  json: boolean;
}

export type ParsedArgv =
  | {
      kind: "ok";
      positionals: string[];
      flags: GlobalFlags;
      /** Every `--name value` flag seen, including command-specific ones (last occurrence wins). */
      values: Record<string, string>;
      /** Every occurrence of each value flag, in argv order, for repeatable flags (e.g. `ask --option a --option b`). */
      lists: Record<string, string[]>;
    }
  | { kind: "error"; message: string };

function isValueFlag(name: string): name is ValueFlag {
  return (VALUE_FLAGS as readonly string[]).includes(name);
}

const BOOLEAN_ONLY_FLAGS = new Set([
  "--wait",
  "--multi-select",
  "--outline",
  "--include-thinking",
  "--force",
]);

/**
 * Generalized argv parse: `--json` and the `BOOLEAN_ONLY_FLAGS` are booleans;
 * every other `--x` consumes the next token as its value (erroring if absent
 * or `--`-prefixed). Global value flags are surfaced typed in `flags`; ALL
 * value flags land in `values` for command-specific reads. Unknown-flag
 * rejection is deferred to `checkFlags` per command so subcommands can declare
 * their own flags.
 */
export function parseArgv(argv: string[]): ParsedArgv {
  const flags: GlobalFlags = { json: false };
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--version") {
      positionals.push("version");
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--json") {
      flags.json = true;
      continue;
    }
    // Valueless boolean flags (they consume no value). They land in `values`
    // as markers so per-command `checkFlags` still rejects them where not
    // allowed; commands that accept them read `values["wait"] !== undefined`.
    if (BOOLEAN_ONLY_FLAGS.has(arg)) {
      values[arg.slice(2)] = "true";
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (name === "") {
      return { kind: "error", message: `invalid flag "${arg}"` };
    }
    let value: string | undefined;
    if (eq === -1) {
      value = argv[i + 1];
      i++;
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      return { kind: "error", message: `flag --${name} requires a value` };
    }
    values[name] = value;
    (lists[name] ??= []).push(value);
    if (isValueFlag(name)) flags[name] = value;
  }

  return { kind: "ok", positionals, flags, values, lists };
}

/**
 * Reject any value flag outside the global set ∪ the command's extras. Keeps
 * `<command> --frob bar` at exit 2 even though the parser now defers
 * unknown-flag detection. Returns null when every flag is allowed.
 */
export function checkFlags(
  values: Record<string, string>,
  extraAllowed: readonly string[],
  json: boolean,
): CliResult | null {
  const allowed = new Set<string>([...VALUE_FLAGS, ...extraAllowed]);
  for (const name of Object.keys(values)) {
    if (!allowed.has(name)) {
      return usageFailure(`unknown flag "--${name}"`, json);
    }
  }
  return null;
}

/**
 * The --json envelope shared by every command. `hint` is reserved for a
 * single advisory next-step line (doc 01 §6) — load-bearing protocol never
 * goes in it, so agents can ignore it safely.
 */
export interface JsonEnvelope {
  ok: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

export function render(
  json: boolean,
  humanStdout: string,
  envelope: JsonEnvelope,
): string {
  if (json) return `${JSON.stringify(envelope)}\n`;
  // Text format: the hint is the final output line, prefixed `hint:` (§6).
  return envelope.hint === undefined
    ? humanStdout
    : `${humanStdout}hint: ${envelope.hint}\n`;
}

export interface FailureInput {
  exitCode: number;
  /** One actionable line, printed first on stderr. */
  message: string;
  detail?: string;
  hint?: string;
  json: boolean;
}

export function failure(input: FailureInput): CliResult {
  const stderrLines = [input.message];
  if (input.detail) stderrLines.push(input.detail);
  if (!input.json && input.hint) stderrLines.push(`hint: ${input.hint}`);
  const envelope: JsonEnvelope = { ok: false, error: input.message };
  if (input.hint) envelope.hint = input.hint;
  return {
    exitCode: input.exitCode,
    stdout: input.json ? `${JSON.stringify(envelope)}\n` : "",
    stderr: `${stderrLines.join("\n")}\n`,
  };
}

export function usageFailure(message: string, json: boolean): CliResult {
  return {
    exitCode: EXIT_USAGE,
    stdout: json ? `${JSON.stringify({ ok: false, error: message })}\n` : "",
    stderr: `cctl: ${message}\n\n${USAGE}`,
  };
}

export type TokenSource = "flag" | "env" | "file";

export interface ResolvedToken {
  token: string | null;
  source: TokenSource | null;
}

/** Resolution order per doc 01 §2: flags > env vars > <configDir>/api-token. */
export async function resolveToken(
  flags: GlobalFlags,
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
 * Resolve server + project (flags > env, doc 01 §2). Each missing piece is an
 * exit-2 usage failure naming the variable to set. Used by project-scoped
 * commands (e.g. `workflow list`) that do not need a session identity.
 */
export async function resolveProjectContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  { ok: true; context: ProjectContext } | { ok: false; result: CliResult }
> {
  const json = flags.json;
  const server = flags.server ?? env["CC_SERVER_URL"];
  if (!server) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message: "no server URL — pass --server or set CC_SERVER_URL",
        json,
      }),
    };
  }
  const project = flags.project ?? env["CC_PROJECT"];
  if (!project) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message: "no project — pass --project or set CC_PROJECT",
        json,
      }),
    };
  }

  const { token, source } = await resolveToken(flags, env, host);
  return {
    ok: true,
    context: { server, project, token, tokenSource: source },
  };
}

/**
 * Resolve server + project + session (flags > env, doc 01 §2). Extends the
 * project context with the session identity; a missing session is an exit-2
 * usage failure. Cross-session safety (doc 01 §4) falls out for free: the env
 * yields exactly one identity, and flags are the only way to target another.
 */
export async function resolveSessionContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  { ok: true; context: SessionContext } | { ok: false; result: CliResult }
> {
  const base = await resolveProjectContext(flags, env, host);
  if (!base.ok) return base;

  const session = flags.session ?? env["CC_SESSION"];
  if (!session) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message: "no session — pass --session or set CC_SESSION",
        json: flags.json,
      }),
    };
  }

  return { ok: true, context: { ...base.context, session } };
}

/**
 * Resolve server + project + session + conversation (flags > env, doc 01 §2).
 * Extends the session context with the conversation identity; a missing
 * conversation is an exit-2 usage failure. Used by conversation-scoped commands
 * (e.g. `charter write`, `decisions propose`) whose payload is authored by a
 * specific conversation but posted to a session-scoped URL.
 */
export async function resolveConversationContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  { ok: true; context: ConversationContext } | { ok: false; result: CliResult }
> {
  const base = await resolveSessionContext(flags, env, host);
  if (!base.ok) return base;

  const conversation = flags.conversation ?? env["CC_CONVERSATION_ID"];
  if (!conversation) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message:
          "no conversation — pass --conversation or set CC_CONVERSATION_ID",
        json: flags.json,
      }),
    };
  }

  return { ok: true, context: { ...base.context, conversation } };
}

/**
 * Resolve server + project + session + graph-workflow lane identity. Extends the
 * session context with the lane's execution + context ids, read ONLY from the
 * env CC injects for lane conversations (`CC_WORKFLOW_EXECUTION_ID` /
 * `CC_WORKFLOW_CONTEXT_ID`). A missing lane id is an exit-2 usage failure naming
 * the variable — the command was run outside a graph-workflow lane. Used by the
 * `cctl workflow task complete|add`, `shared-doc upsert`, and `collab request`
 * verbs.
 */
export async function resolveLaneContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  { ok: true; context: LaneContext } | { ok: false; result: CliResult }
> {
  const base = await resolveSessionContext(flags, env, host);
  if (!base.ok) return base;

  const executionId = env["CC_WORKFLOW_EXECUTION_ID"];
  if (!executionId) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message:
          "no workflow execution — set CC_WORKFLOW_EXECUTION_ID (lane conversations only)",
        json: flags.json,
      }),
    };
  }
  const contextId = env["CC_WORKFLOW_CONTEXT_ID"];
  if (!contextId) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_USAGE,
        message:
          "no workflow context — set CC_WORKFLOW_CONTEXT_ID (lane conversations only)",
        json: flags.json,
      }),
    };
  }

  return { ok: true, context: { ...base.context, executionId, contextId } };
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Read a JSON-object file for a `--file` command. Every failure — unreadable,
 * malformed JSON, or a non-object root — is a local usage error (exit 2) before
 * any request is made, so the offending file is named without a round-trip.
 * `label` names the file kind in the message (e.g. "plan", "charter").
 */
export async function readJsonObjectFile(
  host: CliHost,
  filePath: string,
  label: string,
  json: boolean,
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; result: CliResult }
> {
  const raw = await host.readTextFile(filePath);
  if (raw === null) {
    return {
      ok: false,
      result: usageFailure(`cannot read ${label} file "${filePath}"`, json),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      result: usageFailure(
        `${label} file "${filePath}" is not valid JSON`,
        json,
      ),
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      result: usageFailure(
        `${label} file "${filePath}" must be a JSON object`,
        json,
      ),
    };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export interface RequestIssue {
  path: string;
  message: string;
}

export type CliRequestResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "connection"; detail: string }
  | { kind: "auth"; hadToken: boolean; tokenSource: TokenSource | null }
  | {
      kind: "error";
      status: number;
      error: string;
      issues?: RequestIssue[];
      /** Machine-readable error code when the endpoint supplies one (e.g. `NO_DEV_SERVERS_CONFIGURED`). */
      code?: string;
    };

export interface CliRequestParams {
  server: string;
  token: string | null;
  tokenSource: TokenSource | null;
  method: string;
  path: string;
  body?: unknown;
  /** Extra request headers (e.g. the caller-conversation audit header). */
  headers?: Record<string, string>;
}

function coerceIssues(value: unknown): RequestIssue[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const issues: RequestIssue[] = [];
  for (const entry of value) {
    if (entry && typeof entry === "object") {
      const path = (entry as { path?: unknown }).path;
      const message = (entry as { message?: unknown }).message;
      issues.push({
        path: typeof path === "string" ? path : String(path ?? ""),
        message: typeof message === "string" ? message : String(message ?? ""),
      });
    }
  }
  return issues.length > 0 ? issues : undefined;
}

function buildRequestInit(params: CliRequestParams): FetchInit {
  const headers: Record<string, string> = {
    "x-cc-cli-build": formatBuildStamp(BUILD_INFO),
    "content-type": "application/json",
    ...(params.headers ?? {}),
  };
  if (params.token !== null)
    headers["authorization"] = `Bearer ${params.token}`;

  const init: FetchInit = { method: params.method, headers };
  if (params.body !== undefined) init.body = JSON.stringify(params.body);
  return init;
}

function classifyErrorBody(
  status: number,
  body: unknown,
): Extract<CliRequestResult, { kind: "error" }> {
  const errorMessage =
    body &&
    typeof body === "object" &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `server responded with HTTP ${status}`;
  const issues =
    body && typeof body === "object"
      ? coerceIssues((body as { issues?: unknown }).issues)
      : undefined;
  const code =
    body &&
    typeof body === "object" &&
    typeof (body as { code?: unknown }).code === "string"
      ? (body as { code: string }).code
      : undefined;
  return {
    kind: "error",
    status,
    error: errorMessage,
    ...(issues ? { issues } : {}),
    ...(code ? { code } : {}),
  };
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
  const url = new URL(params.path, params.server);
  const init = buildRequestInit(params);

  let response: Response;
  try {
    response = await host.fetch(url.toString(), init);
  } catch (error) {
    return {
      kind: "connection",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

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

  if (response.ok) return { kind: "ok", status: response.status, body };

  return classifyErrorBody(response.status, body);
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
  const url = new URL(params.path, params.server);
  const init = buildRequestInit(params);

  let response: Response;
  try {
    response = await host.fetch(url.toString(), init);
  } catch (error) {
    return {
      kind: "connection",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status === 401) {
    return {
      kind: "auth",
      hadToken: params.token !== null,
      tokenSource: params.tokenSource,
    };
  }

  const text = await response.text();
  if (response.ok) return { kind: "ok", status: response.status, text };

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return classifyErrorBody(response.status, body);
}

/**
 * Map a non-ok request result to a CliResult per the shared exit-code contract
 * (doc 01 §6): connection → 3, 401 → 3, 400/422 validation → 2 (one issue per
 * line), any other non-2xx → 1 ("server said no").
 */
export function failureFromRequest(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (result.kind === "connection") {
    return failure({
      exitCode: EXIT_CONNECTION,
      message: "cannot reach the CC server — is the CC server running?",
      detail: result.detail,
      hint: "start the CC server, then re-run `cctl doctor`",
      json,
    });
  }
  if (result.kind === "auth") {
    const message = !result.hadToken
      ? "no API token — pass --token, set CC_API_TOKEN, or run the CC server once to provision <configDir>/api-token"
      : `the server rejected the API token (source: ${result.tokenSource ?? "-"})`;
    return failure({
      exitCode: EXIT_CONNECTION,
      message,
      hint: "run `cctl doctor` to check connectivity and auth",
      json,
    });
  }
  if (result.status === 400 || result.status === 422) {
    const detail =
      result.issues && result.issues.length > 0
        ? result.issues.map((i) => `  ${i.path}: ${i.message}`).join("\n")
        : undefined;
    return failure({
      exitCode: EXIT_USAGE,
      message: result.error,
      ...(detail ? { detail } : {}),
      json,
    });
  }
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message: result.error,
    json,
  });
}

/**
 * Like {@link failureFromRequest}, but a 404 is treated as a caller/config
 * mistake (exit 2) rather than a server "no" (exit 1): a missing project or
 * session means the invocation targeted something that does not exist.
 */
export function failureFromRequestNotFoundAsUsage(
  result: Exclude<CliRequestResult, { kind: "ok" }>,
  json: boolean,
): CliResult {
  if (result.kind === "error" && result.status === 404) {
    return failure({ exitCode: EXIT_USAGE, message: result.error, json });
  }
  return failureFromRequest(result, json);
}
