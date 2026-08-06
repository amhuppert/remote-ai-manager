import path from "node:path";
import {
  BUILD_MISMATCH_HEADER,
  parseBuildMismatchHeader,
} from "@/lib/agent-gateway/build-parity";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { resolveConfigDirFrom } from "@/lib/config/config-dir";
import {
  projectConversationTarget,
  sessionConversationTarget,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { createLogger } from "@/lib/logging";
import { booleanFlagNames, renderTopUsage } from "./help-registry";
import { flattenDiagnosticText } from "@/lib/shared/diagnostic-text";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("cli.shared");

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
  /**
   * Binary request body (e.g. a multipart file upload). Wins over `body` when
   * both are set; hosts pass it to fetch verbatim. A separate field (rather
   * than widening `body`) so existing string-body assertions and hosts stay
   * untouched.
   */
  rawBody?: Uint8Array<ArrayBuffer>;
  /**
   * Optional per-request timeout in ms. The real host (`index.ts`) maps it to
   * `AbortSignal.timeout`; injected test hosts ignore it. Used by the
   * best-effort help-context fetch (doc 04 §4.4), which must fail open on
   * timeout so `--help` never stalls.
   */
  timeoutMs?: number;
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
   * Read a file's raw bytes (binary-safe, e.g. ticket file attachments), or
   * null when it does not exist / is unreadable.
   */
  readFileBytes(filePath: string): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Write a UTF-8 output file for commands with an explicit output target. */
  writeTextFile?(filePath: string, content: string): Promise<void>;
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

/**
 * Top-level usage — generated from the help registry's level-1 entries plus the
 * hand-written global-flags block (docs/design/cc-cli/04 §2.3). Computed once at
 * module init; the registry is the single source of the command list, so a new
 * command's summary appears here the moment its entry lands.
 */
export const USAGE = renderTopUsage();

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

/**
 * The parse-time boolean-flag set, derived from the help registry: every flag
 * declared `kind: "boolean"` across all entries, as its `--name` arg form
 * (docs/design/cc-cli/04 §2.3). Computed once at module init. `--help` is NOT a
 * registry flag — it is a parser-intrinsic pseudo-flag handled explicitly in
 * `parseArgv` (like `-h`/`--version`), so help interception works before any
 * command dispatch.
 */
const BOOLEAN_FLAG_ARGS = new Set(
  booleanFlagNames().map((name) => `--${name}`),
);

/**
 * Generalized argv parse: `--json`, `--help`, and every boolean flag in
 * `booleanArgs` are booleans; every other `--x` consumes the next token as its
 * value (erroring if absent or `--`-prefixed). Global value flags are surfaced
 * typed in `flags`; ALL value flags land in `values` for command-specific
 * reads. Unknown-flag rejection is deferred to `checkFlags` per command so
 * subcommands can declare their own flags.
 *
 * `booleanArgs` is the set of `--name` arg forms to treat as booleans. It
 * defaults to the global union of every registry-declared boolean flag — the
 * right set for a first "probe" parse that only needs the command path. The
 * authoritative parse passes the COMMAND-SCOPED set
 * (`booleanFlagArgsForCommand`) so a flag can be boolean for one command and
 * value for another (e.g. `workflow get --config` vs `workflow live get
 * --config <id>`, doc 06).
 */
export function parseArgv(
  argv: string[],
  booleanArgs: Set<string> = BOOLEAN_FLAG_ARGS,
): ParsedArgv {
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
    if (arg === "-h" || arg === "--help") {
      values["help"] = "true";
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
    if (booleanArgs.has(arg)) {
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
 * The --json envelope shared by every command. The three output tiers (doc 01
 * §6 / steering `cli.md`) are typed here so every command shares one contract:
 * `hint` is a single advisory next step (ignorable), `reminders` are invariants
 * to keep true while work continues, and `instruction` is load-bearing do-now
 * text the caller obeys first.
 */
export interface JsonEnvelope {
  ok: boolean;
  error?: string;
  hint?: string;
  reminders?: string[];
  /**
   * Load-bearing do-now text (tier 3, "obey first"): `ask`'s end-turn note and a
   * lane `task complete`'s context-rotation stop. When present, `render`/`failure`
   * emit it as primary output and suppress any `hint` — a "continue" hint must
   * never sit beside a "stop" instruction (doc 01 §6). `stopInstruction` is the
   * retained legacy field name for the same tier.
   */
  instruction?: string;
  stopInstruction?: string;
  /** Structured validation issues, when the server supplies them (doc 04 §5.1). */
  issues?: RequestIssue[];
  /** Machine-readable error code, when the server supplies one. */
  code?: string;
  /** Structured operational-refusal context selected by the error code. */
  details?: CliErrorDetails;
  [key: string]: unknown;
}

/** True when the envelope carries a tier-3 instruction (either field name). */
function hasInstruction(envelope: JsonEnvelope): boolean {
  return (
    envelope.instruction !== undefined || envelope.stopInstruction !== undefined
  );
}

export function render(
  json: boolean,
  humanStdout: string,
  envelope: JsonEnvelope,
): string {
  // The one tier rule the renderer owns for every command: a load-bearing
  // instruction suppresses the advisory hint, in BOTH modes — the two are
  // mutually exclusive at the decision point (doc 01 §6). A command may pass its
  // remaining-count `hint` and a rotation `instruction` together and trust the
  // renderer to never surface both. The instruction's own HUMAN text stays in
  // the caller's primary body (its phrasing is command-specific — e.g. `ask`'s
  // doc-frozen multi-line end-turn note); the renderer only arbitrates the hint.
  const instructionPresent = hasInstruction(envelope);
  if (json) {
    if (instructionPresent && envelope.hint !== undefined) {
      const withoutHint: JsonEnvelope = { ...envelope };
      delete withoutHint.hint;
      return `${JSON.stringify(withoutHint)}\n`;
    }
    return `${JSON.stringify(envelope)}\n`;
  }
  // Text tier order (doc 04 §1.2/§5.1): primary body (which carries any
  // instruction phrasing), then each reminder as a `reminder:` line, then the
  // advisory `hint:` line last — omitted when an instruction is present.
  let out = humanStdout;
  if (envelope.reminders) {
    for (const reminder of envelope.reminders) out += `reminder: ${reminder}\n`;
  }
  if (!instructionPresent && envelope.hint !== undefined) {
    out += `hint: ${envelope.hint}\n`;
  }
  return out;
}

export interface FailureInput {
  exitCode: number;
  /** One actionable line, printed first on stderr. */
  message: string;
  detail?: string;
  hint?: string;
  reminders?: string[];
  /** Load-bearing server-authored next step for an operational refusal. */
  instruction?: string;
  /**
   * Structured validation issues + machine-readable code. JSON-envelope only —
   * text mode still renders the human `detail`, so callers pass BOTH (doc 04 §5.1).
   */
  issues?: RequestIssue[];
  code?: string;
  details?: CliErrorDetails;
  json: boolean;
}

export function failure(input: FailureInput): CliResult {
  const stderrLines = [input.message];
  if (input.detail) stderrLines.push(input.detail);
  if (!input.json && input.instruction)
    stderrLines.push(`instruction: ${input.instruction}`);
  // Text tier order (doc 04 §5.1): message -> detail/issues -> reminders -> hint.
  if (!input.json && input.reminders) {
    for (const reminder of input.reminders)
      stderrLines.push(`reminder: ${reminder}`);
  }
  if (!input.json && input.hint) stderrLines.push(`hint: ${input.hint}`);
  const envelope: JsonEnvelope = { ok: false, error: input.message };
  if (input.issues && input.issues.length > 0) envelope.issues = input.issues;
  if (input.code) envelope.code = input.code;
  if (input.details) envelope.details = input.details;
  if (input.reminders && input.reminders.length > 0)
    envelope.reminders = input.reminders;
  if (input.instruction) envelope.instruction = input.instruction;
  if (input.hint && !input.instruction) envelope.hint = input.hint;
  return {
    exitCode: input.exitCode,
    stdout: input.json ? `${JSON.stringify(envelope)}\n` : "",
    stderr: `${stderrLines.join("\n")}\n`,
  };
}

export function usageFailure(message: string, json: boolean): CliResult {
  const hint = "run 'cctl --help' or 'cctl <command> --help' for usage";
  return {
    exitCode: EXIT_USAGE,
    stdout: json
      ? `${JSON.stringify({ ok: false, error: message, hint })}\n`
      : "",
    stderr: `cctl: ${message}\nhint: ${hint}\n`,
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
      result: usageFailure(
        "no server URL — pass --server or set CC_SERVER_URL",
        json,
      ),
    };
  }
  const project = flags.project ?? env["CC_PROJECT"];
  if (!project) {
    return {
      ok: false,
      result: usageFailure(
        "no project — pass --project or set CC_PROJECT",
        json,
      ),
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

  const session = flags.session ?? readSessionEnv(env);
  if (!session) {
    return {
      ok: false,
      result: usageFailure(
        "no session — pass --session or set CC_SESSION",
        flags.json,
      ),
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
      result: usageFailure(
        "no conversation — pass --conversation or set CC_CONVERSATION_ID",
        flags.json,
      ),
    };
  }

  return { ok: true, context: { ...base.context, conversation } };
}

/**
 * Resolve server + project + the authoring conversation's id, WITHOUT a session.
 *
 * For commands whose endpoints are project-scoped and only need to know which
 * conversation is speaking (spec authoring records authorship, it does not route
 * by session). Demanding a session here would break these commands for every
 * project conversation while buying nothing — the exact "incidental coupling to
 * a session lookup" the scope contract removes.
 */
export async function resolveProjectConversationContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  | { ok: true; context: ProjectConversationContext }
  | { ok: false; result: CliResult }
> {
  const base = await resolveProjectContext(flags, env, host);
  if (!base.ok) return base;

  const conversation = flags.conversation ?? env["CC_CONVERSATION_ID"];
  if (!conversation) {
    return {
      ok: false,
      result: usageFailure(
        "no conversation — pass --conversation or set CC_CONVERSATION_ID",
        flags.json,
      ),
    };
  }

  return { ok: true, context: { ...base.context, conversation } };
}

/**
 * Resolve server + project + conversation into a scope-DISCRIMINATED target
 * (R2.4, D1) for the commands classified project-supported in
 * `session-env-inventory.ts`. Route construction then goes through
 * `conversationTargetApiBase`, so neither scope can be spelled by hand.
 *
 * Scope selection: an explicit `--session` always wins (a human targeting
 * another session), then the environment's declared `CC_CONVERSATION_SCOPE`,
 * then a non-empty env session. With none of those the command has no
 * conversation identity to address and fails with the ordinary usage error.
 */
export async function resolveConversationTargetContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  | { ok: true; context: ConversationTargetContext }
  | { ok: false; result: CliResult }
> {
  const base = await resolveProjectContext(flags, env, host);
  if (!base.ok) return base;

  const conversation = flags.conversation ?? env["CC_CONVERSATION_ID"];
  if (!conversation) {
    return {
      ok: false,
      result: usageFailure(
        "no conversation — pass --conversation or set CC_CONVERSATION_ID",
        flags.json,
      ),
    };
  }

  const explicitSession = flags.session ?? null;
  const envSession = readSessionEnv(env);
  const declaredScope = readConversationScope(env);
  const sessionName =
    explicitSession ?? (declaredScope === "project" ? null : envSession);

  if (sessionName === null && declaredScope === null) {
    return {
      ok: false,
      result: usageFailure(
        "no conversation scope — pass --session, or set CC_SESSION or CC_CONVERSATION_SCOPE",
        flags.json,
      ),
    };
  }

  const target: ConversationTarget =
    sessionName === null
      ? projectConversationTarget(base.context.project, conversation)
      : sessionConversationTarget(
          base.context.project,
          sessionName,
          conversation,
        );

  return { ok: true, context: { ...base.context, target } };
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
      result: usageFailure(
        "no workflow execution — set CC_WORKFLOW_EXECUTION_ID (lane conversations only)",
        flags.json,
      ),
    };
  }
  const contextId = env["CC_WORKFLOW_CONTEXT_ID"];
  if (!contextId) {
    return {
      ok: false,
      result: usageFailure(
        "no workflow context — set CC_WORKFLOW_CONTEXT_ID (lane conversations only)",
        flags.json,
      ),
    };
  }

  return { ok: true, context: { ...base.context, executionId, contextId } };
}

export function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * A soft stderr advisory for a `--file` payload path a lane commit could sweep
 * into the branch. `--file` payloads (plan / questions / doc / charter … JSON)
 * are throwaway scratch — the CLI reads them once and never needs them again —
 * but a graph-workflow lane commits its whole worktree with `git add -A` at
 * land time, so a payload left at the worktree root lands in the diff the
 * context validator reviews and derails the context. CC's `.cc/` namespace is
 * git-ignored, so `.cc/temp/` is the safe home for these files.
 *
 * We nudge only worktree-relative paths outside `.cc/`: a relative path
 * resolves against the agent's cwd (always its worktree), so it is exactly a
 * file at risk. Absolute paths (the worktree root is unknown to the CLI here)
 * and stdin (`-`) are out of scope — the observed footgun is the documented
 * bare `--file doc.json`. Returns a newline-terminated advisory line, or
 * undefined when no nudge is warranted.
 */
export function ccTempPayloadAdvisory(filePath: string): string | undefined {
  if (filePath === "-" || path.isAbsolute(filePath)) return undefined;
  const segments = path.normalize(filePath).split(path.sep);
  if (segments.includes(".cc")) return undefined;
  return `note: "${filePath}" is outside .cc/ — author cctl --file payloads under .cc/temp/ so a lane commit ('git add -A') doesn't sweep them into the branch\n`;
}

/**
 * Read a JSON-object file for a `--file` command. Every failure — unreadable,
 * malformed JSON, or a non-object root — is a local usage error (exit 2) before
 * any request is made, so the offending file is named without a round-trip.
 * `label` names the file kind in the message (e.g. "plan", "charter"). The soft
 * "author it under .cc/temp/" location nudge is applied centrally in `runCli`
 * (keyed on `--file`), not here — see {@link ccTempPayloadAdvisory}.
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

/**
 * The one located-issue rendering: `  <path>: <message>`, one issue per line
 * (doc 01 §6).
 *
 * The line is flattened here rather than trusted from the server. A validation
 * message quotes values out of the document that failed — a malformed id is
 * exactly what it reports — and a raw newline in one would split a single issue
 * across two lines, the second indistinguishable from a genuine located issue.
 * Producers escape their own interpolated values; this is the surface that
 * PROMISES one line, so it is also the one that guarantees it, whatever the
 * message was assembled from. The JSON envelope carries the issues unflattened:
 * JSON quoting is already unambiguous.
 */
export function issueDetailLines(issues: readonly RequestIssue[]): string[] {
  return issues.map(
    (issue) =>
      `  ${flattenDiagnosticText(issue.path)}: ${flattenDiagnosticText(issue.message)}`,
  );
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
  | LintBlockedCliErrorDetails
  | StaleElementCliErrorDetails
  | Record<string, unknown>;

export type CliRequestResult =
  | { kind: "ok"; status: number; body: unknown }
  | { kind: "connection"; detail: string }
  | { kind: "auth"; hadToken: boolean; tokenSource: TokenSource | null }
  | { kind: "version_mismatch"; serverBuild: string; cliBuild: string }
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

function isRecord(value: unknown): value is Record<string, unknown> {
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

function coerceInstruction(value: unknown): string | undefined {
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
    "x-cc-cli-build": formatBuildStamp(BUILD_INFO),
    "content-type": "application/json",
    ...(params.headers ?? {}),
  };
  if (params.token !== null)
    headers["authorization"] = `Bearer ${params.token}`;

  const init: FetchInit = { method: params.method, headers };
  if (params.rawBody !== undefined) init.rawBody = params.rawBody;
  else if (params.body !== undefined) init.body = JSON.stringify(params.body);
  return init;
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
    ? coerceInstruction(bodyRecord.instruction)
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
  const url = new URL(params.path, params.server);
  const init = buildRequestInit(params);

  let response: Response;
  try {
    response = await host.fetch(url.toString(), init);
  } catch (error) {
    return {
      kind: "connection",
      detail: getErrorMessage(error),
    };
  }

  if (response.status === 401) {
    return {
      kind: "auth",
      hadToken: params.token !== null,
      tokenSource: params.tokenSource,
    };
  }

  const skew = readBuildMismatch(response);
  if (skew !== null) return skew;

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
      detail: getErrorMessage(error),
    };
  }

  if (response.status === 401) {
    return {
      kind: "auth",
      hadToken: params.token !== null,
      tokenSource: params.tokenSource,
    };
  }

  const skew = readBuildMismatch(response);
  if (skew !== null) return skew;

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
 * The server-supplied structured fields (issues/code/reminders) forwarded onto
 * every JSON failure envelope. JSON-only for issues/code (text mode renders the
 * human `detail` instead); reminders are tier-2 and render in both modes. Shared
 * so every failure seam — validation, generic non-2xx, and the 404-as-usage /
 * artifact helpers — threads the same fields (doc 04 §5.1).
 */
export function structuredErrorFields(
  result: Extract<CliRequestResult, { kind: "error" }>,
): Pick<
  FailureInput,
  "issues" | "code" | "reminders" | "instruction" | "details"
> {
  return {
    ...(result.issues ? { issues: result.issues } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(result.reminders ? { reminders: result.reminders } : {}),
    ...(result.instruction ? { instruction: result.instruction } : {}),
    ...(result.details ? { details: result.details } : {}),
  };
}

function refusalDetailLines(
  result: Extract<CliRequestResult, { kind: "error" }>,
): string[] {
  if (result.code === "lint_blocked" && result.details !== undefined) {
    const findings = (result.details as { findings?: unknown }).findings;
    if (!Array.isArray(findings)) return [];
    return findings.map((finding, index) => {
      if (!isRecord(finding)) {
        return `  findings[${index}]: ${JSON.stringify(finding)}`;
      }
      const handle =
        typeof finding.elementHandle === "string"
          ? finding.elementHandle
          : `finding ${index + 1}`;
      const rule =
        typeof finding.ruleId === "string" ? finding.ruleId : "unknown_rule";
      const severity =
        typeof finding.severity === "string"
          ? finding.severity
          : "unknown_severity";
      const message =
        typeof finding.message === "string"
          ? finding.message
          : JSON.stringify(finding);
      return `  findings[${index}]: ${handle} [${rule}/${severity}] ${message}`;
    });
  }

  if (result.code === "stale_element" && result.details !== undefined) {
    const details = result.details as Partial<StaleElementCliErrorDetails>;
    if (typeof details.currentVersion !== "number") return [];
    return [
      `  details.currentVersion: ${details.currentVersion}`,
      `  details.currentContent: ${JSON.stringify(details.currentContent)}`,
    ];
  }

  return [];
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
  if (result.kind === "version_mismatch") {
    return failure({
      exitCode: EXIT_VERSION_MISMATCH,
      message: `this cctl is build ${result.cliBuild}; the server is build ${result.serverBuild}`,
      detail:
        "  every CC server publishes its own cctl at <its configDir>/bin/cctl — a binary from one server reads a\n  command surface the other does not have, so the result would describe the wrong build",
      hint: "run `cctl doctor --server <url>` to print that server's cctl path, then invoke that binary",
      json,
    });
  }
  const detailLines = [
    ...issueDetailLines(
      result.issues?.filter((issue) => issue.message !== result.error) ?? [],
    ),
    ...refusalDetailLines(result),
  ];
  const detail = detailLines.length > 0 ? detailLines.join("\n") : undefined;
  if (result.status === 400 || result.status === 422) {
    return failure({
      exitCode: EXIT_USAGE,
      message: result.error,
      ...(detail ? { detail } : {}),
      ...structuredErrorFields(result),
      json,
    });
  }
  return failure({
    exitCode: EXIT_OPERATION_FAILED,
    message: result.error,
    ...(result.instruction && detail ? { detail } : {}),
    ...structuredErrorFields(result),
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
    return failure({
      exitCode: EXIT_USAGE,
      message: result.error,
      ...structuredErrorFields(result),
      json,
    });
  }
  return failureFromRequest(result, json);
}
