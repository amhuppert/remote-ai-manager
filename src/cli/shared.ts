import path from "node:path";
import {
  BUILD_MISMATCH_HEADER,
  BUILD_SKEW_CODE,
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
import {
  EXIT_CONNECTION,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
} from "./exit-taxonomy";
import { guidanceLine } from "./guidance-prefixes";
import {
  booleanFlagNames,
  flagNamesFor,
  renderTopUsage,
} from "./help-registry";
import { fileSourceFlagName } from "./help-types";
import { flattenDiagnosticText } from "@/lib/shared/diagnostic-text";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  CONVERSATION_CAPABILITY_ENV_VAR,
  CONVERSATION_CAPABILITY_HEADER,
} from "@/lib/agent-gateway/conversation-capability";
import {
  LANE_CAPABILITY_ENV_VAR,
  LANE_CAPABILITY_HEADER,
} from "@/lib/agent-gateway/lane-capability";

const logger = createLogger("cli.shared");

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Environment as the CLI sees it — a plain record so tests inject it directly. */
export type CliEnv = Record<string, string | undefined>;

export interface CliPrincipalCapabilities {
  conversation?: string;
  lane?: string;
}

/** Signed principal credentials distributed to this agent's environment. */
export function resolveCliPrincipalCapabilities(
  env: CliEnv,
): CliPrincipalCapabilities {
  const conversation = env[CONVERSATION_CAPABILITY_ENV_VAR];
  const lane = env[LANE_CAPABILITY_ENV_VAR];
  return {
    ...(conversation ? { conversation } : {}),
    ...(lane ? { lane } : {}),
  };
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
  /** Stream human progress before the command's final result is available. */
  writeStdout?(text: string): void;
  /**
   * Observe termination signals for commands that own a server-side lease.
   * The returned cleanup removes both listeners.
   */
  onSignal?(listener: (signal: "SIGINT" | "SIGTERM") => void): () => void;
  platform: string;
  homedir: string;
}

/**
 * The exit taxonomy is defined in `exit-taxonomy.ts`, which imports nothing, so
 * a `*.help.ts` entry can derive its body from the table without cycling
 * (`shared.ts` → `help-registry.ts` → `*.help.ts`). Command modules keep reading
 * the codes from this kit.
 */
export {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  EXIT_CONNECTION,
  EXIT_VERSION_MISMATCH,
  EXIT_TAXONOMY,
  exitTaxonomyLines,
  type ExitCodeMeaning,
} from "./exit-taxonomy";

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
      /** Values after the literal `--`; only commands with typed passthrough consume them. */
      passthrough: string[];
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
 * authoritative parse passes the COMMAND-AWARE set
 * (`booleanFlagArgsForCommand`) so a command-local value declaration overrides
 * a boolean declaration elsewhere (e.g. `workflow get --config` vs `workflow
 * live get --config <id>`, doc 06), while undeclared globally-known booleans
 * remain valueless markers for `checkFlags` to reject clearly.
 */
export function parseArgv(
  argv: string[],
  booleanArgs: Set<string> = BOOLEAN_FLAG_ARGS,
): ParsedArgv {
  const flags: GlobalFlags = { json: false };
  const values: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  const positionals: string[] = [];
  let passthrough: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      passthrough = argv.slice(i + 1);
      break;
    }
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
    // allowed; commands read their registered flag name from `values`.
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

  return { kind: "ok", positionals, flags, values, lists, passthrough };
}

/**
 * Reject any value flag outside the global set ∪ the flags the registry entry at
 * `entryPath` declares. Keeps `<command> --frob bar` at exit 2 even though the
 * parser defers unknown-flag detection. Returns null when every flag is allowed.
 *
 * The allowlist is only ever derived — taking the space-joined registry key
 * rather than a name list makes a hand-written allowlist unrepresentable, which
 * is what keeps help and flag enforcement from drifting apart (`cli.md`). The
 * derivation is unconditional so a key naming no entry throws even when there is
 * nothing to check.
 */
export function checkFlags(
  values: Record<string, string>,
  entryPath: string,
  json: boolean,
): CliResult | null {
  const allowed = new Set<string>([...VALUE_FLAGS, ...flagNamesFor(entryPath)]);
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
  /**
   * The one sentence a refusal adds to say its constraint is deliberate.
   * Written only by {@link failure}: it explains a "no", so no success
   * envelope has anything for it to explain.
   */
  rationale?: string;
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

/**
 * The tier policy, owned once for success and failure (doc 01 §6): a
 * load-bearing instruction suppresses the advisory hint in BOTH modes — a
 * "continue" hint must never sit beside a "stop". A command may pass its
 * remaining-count `hint` and a rotation `instruction` together and trust this
 * seam to never surface both.
 *
 * The hint is also flattened here. It PROMISES one line, and a hint assembled
 * from server text or an untrusted value can carry a newline whose second line
 * would be indistinguishable from a forged guidance line; the surface that
 * promises the line is the one that guarantees it.
 */
function arbitrate(envelope: JsonEnvelope): JsonEnvelope {
  const hint = envelope.hint;
  if (hint === undefined) return envelope;
  if (hasInstruction(envelope)) {
    const withoutHint: JsonEnvelope = { ...envelope };
    delete withoutHint.hint;
    return withoutHint;
  }
  const flattened = flattenDiagnosticText(hint);
  return flattened === hint ? envelope : { ...envelope, hint: flattened };
}

/**
 * The text-mode guidance lines of an arbitrated envelope, in tier order
 * (doc 04 §1.2/§5.1): the do-now instruction, then each keep-true `reminder:`,
 * then the one advisory `hint:`.
 *
 * `instructionLine` is false where the caller's primary body already carries
 * the instruction's human phrasing verbatim (its wording is command-specific —
 * e.g. `ask`'s doc-frozen multi-line end-turn note), and true where the body is
 * a one-line failure message that cannot.
 */
function guidanceLines(
  envelope: JsonEnvelope,
  instructionLine: boolean,
): string[] {
  const lines: string[] = [];
  const instruction = envelope.instruction ?? envelope.stopInstruction;
  if (instructionLine && instruction !== undefined) {
    lines.push(guidanceLine("instruction", instruction));
  }
  for (const reminder of envelope.reminders ?? []) {
    lines.push(guidanceLine("reminder", reminder));
  }
  if (envelope.hint !== undefined) {
    lines.push(guidanceLine("hint", envelope.hint));
  }
  return lines;
}

export function render(
  json: boolean,
  humanStdout: string,
  envelope: JsonEnvelope,
): string {
  const arbitrated = arbitrate(envelope);
  if (json) return `${JSON.stringify(arbitrated)}\n`;
  const lines = guidanceLines(arbitrated, false);
  return lines.length === 0
    ? humanStdout
    : `${humanStdout}${lines.join("\n")}\n`;
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
  /** Server-authored reason the refused constraint exists (design §11). */
  rationale?: string;
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
  const envelope = arbitrate({
    ok: false,
    error: input.message,
    ...(input.issues && input.issues.length > 0
      ? { issues: input.issues }
      : {}),
    ...(input.code ? { code: input.code } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(input.reminders && input.reminders.length > 0
      ? { reminders: input.reminders }
      : {}),
    ...(input.rationale ? { rationale: input.rationale } : {}),
    ...(input.instruction ? { instruction: input.instruction } : {}),
    ...(input.hint ? { hint: input.hint } : {}),
  });
  // Text tier order (doc 04 §5.1): message -> detail/issues -> guidance. The
  // rationale sits between them: it explains the conditions just printed, and
  // a reader given the do-now instruction first never reads back up for the
  // reason. Composed here rather than in `guidanceLines` so the success seam
  // has no path to a `why:` line at all.
  const stderrLines = [input.message];
  if (input.detail) stderrLines.push(input.detail);
  if (!input.json) {
    if (input.rationale) {
      stderrLines.push(guidanceLine("why", input.rationale));
    }
    stderrLines.push(...guidanceLines(envelope, true));
  }
  return {
    exitCode: input.exitCode,
    stdout: input.json ? `${JSON.stringify(envelope)}\n` : "",
    stderr: `${stderrLines.join("\n")}\n`,
  };
}

/** The diagnosis every unreachable-server failure hands the caller. */
const DOCTOR_POINTER = "run `cctl doctor` to check the CC server connection";

/**
 * Exit 3 — the connection/auth class — constructed in one place so the taxonomy
 * promise holds: an agent that cannot reach the server is told which command
 * diagnoses that, whatever the command it was running. A caller's own recovery
 * hint is kept and the pointer appended, because the caller's is the more
 * specific one (start the dev server, fix the token) and the pointer is the
 * fallback when it does not help.
 */
export function connectionFailure(
  input: Omit<FailureInput, "exitCode">,
): CliResult {
  const hint =
    input.hint === undefined
      ? DOCTOR_POINTER
      : input.hint.includes("cctl doctor")
        ? input.hint
        : `${input.hint} — ${DOCTOR_POINTER}`;
  return failure({ ...input, exitCode: EXIT_CONNECTION, hint });
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

export interface ClientAdvisory {
  /** The recorded failure that earned this reminder (admission rule). */
  evidence: string;
  /** The reminder body: one line, no tier prefix — the renderer owns both. */
  reminder(subject: string): string;
}

/**
 * The complete set of CLIENT-authored reminders. Reminders are otherwise
 * server-authored (steering `cli.md`): the server holds the state that decides
 * whether an invariant is worth repeating. These are the enumerated exception —
 * invariants about the caller's own filesystem, which no server can observe.
 * Adding an entry is an edit to this list, with its evidence, in review.
 */
export const CLIENT_ADVISORIES = {
  payload_outside_cc: {
    evidence:
      "A graph-workflow lane commits its whole worktree ('git add -A') at land time, so a payload left at the worktree root landed in the diff its context validator reviewed and derailed the context.",
    reminder: (filePath: string) =>
      `"${filePath}" is outside .cc/ — author cctl payload files under .cc/temp/ so a lane commit ('git add -A') doesn't sweep them into the branch`,
  },
} satisfies Record<string, ClientAdvisory>;

/**
 * The payload-location reminder for a file a lane commit could sweep into the
 * branch, or undefined when the path is not at risk. File-backed payloads (plan
 * / inputs / questions / doc / charter JSON) are throwaway scratch, and CC's
 * `.cc/` namespace is git-ignored, so `.cc/temp/` is their safe home.
 *
 * Only worktree-relative paths outside `.cc/` qualify: a relative path resolves
 * against the agent's cwd (always its worktree), so it is exactly a file at
 * risk. Absolute paths (the worktree root is unknown to the CLI here) and stdin
 * (`-`) are out of scope — the observed footgun is the documented bare
 * `--file doc.json`.
 */
export function ccTempPayloadAdvisory(filePath: string): string | undefined {
  if (filePath === "-" || path.isAbsolute(filePath)) return undefined;
  const segments = path.normalize(filePath).split(path.sep);
  if (segments.includes(".cc")) return undefined;
  return CLIENT_ADVISORIES.payload_outside_cc.reminder(filePath);
}

/**
 * Merge a client advisory into a result a command already rendered, so text and
 * `--json` carry the same fact. Text mode keeps the tier order by placing the
 * line ahead of a trailing `hint:`; JSON mode appends to the envelope's
 * `reminders`, and falls back to stderr rather than writing prose into stdout
 * that a caller is parsing.
 */
export function withClientReminder(
  result: CliResult,
  json: boolean,
  reminder: string,
): CliResult {
  if (json) {
    const envelope = parseEnvelopeStdout(result.stdout);
    if (envelope === null) {
      return { ...result, stderr: `${result.stderr}reminder: ${reminder}\n` };
    }
    const existing = Array.isArray(envelope.reminders)
      ? envelope.reminders.filter(
          (entry): entry is string => typeof entry === "string",
        )
      : [];
    return {
      ...result,
      stdout: `${JSON.stringify({ ...envelope, reminders: [...existing, reminder] })}\n`,
    };
  }
  const line = `reminder: ${reminder}\n`;
  if (result.stdout === "") return { ...result, stdout: line };
  if (!result.stdout.endsWith("\n")) {
    return { ...result, stdout: `${result.stdout}\n${line}` };
  }
  const lines = result.stdout.split("\n");
  const insertAt =
    lines.length >= 2 && (lines[lines.length - 2] ?? "").startsWith("hint: ")
      ? lines.length - 2
      : lines.length - 1;
  lines.splice(insertAt, 0, `reminder: ${reminder}`);
  return { ...result, stdout: lines.join("\n") };
}

function parseEnvelopeStdout(stdout: string): Record<string, unknown> | null {
  if (stdout === "") return null;
  try {
    const parsed: unknown = JSON.parse(stdout);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Prose payloads are agent-authored scratch — a task summary, a brief, a note.
 * 256 KiB is orders of magnitude past any of them and well short of the binary
 * or transcript a mis-pointed path would drag in, so the cap catches the wrong
 * file without ever refusing a real one.
 */
const PROSE_FILE_MAX_BYTES = 256 * 1024;

/**
 * The one value behind a `fileSource` flag: either the inline `--<name>` or the
 * derived `--<name>-file <path>` (`-` reads stdin through the host). Returns
 * `undefined` when neither is present — whether the argument is required is the
 * command's decision, and only the command can word its own usage failure.
 *
 * Every refusal is exit 2 before any request: the argument is load-bearing
 * prose, so a truncated, doubled, or unreadable one must not reach the server
 * as content.
 */
export async function resolveProseArg(
  values: Record<string, string>,
  host: CliHost,
  name: string,
  json: boolean,
): Promise<
  { ok: true; value: string | undefined } | { ok: false; result: CliResult }
> {
  const fileFlag = fileSourceFlagName(name);
  const inline = values[name];
  const filePath = values[fileFlag];
  if (inline !== undefined && filePath !== undefined) {
    return {
      ok: false,
      result: usageFailure(
        `--${name} and --${fileFlag} are alternatives — pass exactly one`,
        json,
      ),
    };
  }
  if (filePath === undefined) return { ok: true, value: inline };

  const raw = await host.readTextFile(filePath);
  if (raw === null) {
    return {
      ok: false,
      result: usageFailure(`cannot read --${fileFlag} "${filePath}"`, json),
    };
  }
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > PROSE_FILE_MAX_BYTES) {
    return {
      ok: false,
      result: usageFailure(
        `--${fileFlag} "${filePath}" is ${bytes} bytes — the limit is ${PROSE_FILE_MAX_BYTES}`,
        json,
      ),
    };
  }
  // Surrounding whitespace is an artifact of how the file was written, not part
  // of the prose; an all-whitespace file is a mis-authored payload, not content.
  const text = raw.trim();
  if (text === "") {
    return {
      ok: false,
      result: usageFailure(`--${fileFlag} "${filePath}" is empty`, json),
    };
  }
  return { ok: true, value: text };
}

/**
 * Read a JSON-object file for a file-backed command. Every failure — unreadable,
 * malformed JSON, or a non-object root — is a local usage error (exit 2) before
 * any request is made, so the offending file is named without a round-trip.
 * `label` names the file kind in the message (e.g. "plan", "charter"). The soft
 * "author it under .cc/temp/" location nudge is applied centrally in `runCli`
 * (keyed on the command's payload flag), not here — see
 * {@link ccTempPayloadAdvisory}.
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

/**
 * A gated server refuses skewed mutations before the handler runs
 * (`src/middleware.ts`), which is what lets that refusal state that nothing
 * changed. The post-response header check still covers reads — and mutations
 * against a server that predates the gate, where the handler already ran and
 * the effect may have committed, so that path must hedge instead.
 */
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
  | { kind: "connection"; detail: string }
  | { kind: "auth"; hadToken: boolean; tokenSource: TokenSource | null }
  | {
      kind: "version_mismatch";
      serverBuild: string;
      cliBuild: string;
      /**
       * The HTTP method of the discarded request. A header-only mismatch means
       * the server ran the handler (a gated server refuses with `build_skew`
       * instead), so the method decides whether "nothing changed" is true.
       */
      method: string;
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
  /** Server-signed caller authority; values are never logged. */
  principalCapabilities?: CliPrincipalCapabilities;
  /** Bound the complete HTTP operation; the real host aborts at this deadline. */
  timeoutMs?: number;
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
    ...(params.principalCapabilities?.conversation
      ? {
          [CONVERSATION_CAPABILITY_HEADER]:
            params.principalCapabilities.conversation,
        }
      : {}),
    ...(params.principalCapabilities?.lane
      ? { [LANE_CAPABILITY_HEADER]: params.principalCapabilities.lane }
      : {}),
  };
  if (params.token !== null)
    headers["authorization"] = `Bearer ${params.token}`;

  const init: FetchInit = { method: params.method, headers };
  if (params.timeoutMs !== undefined) init.timeoutMs = params.timeoutMs;
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
  method: string,
): Extract<CliRequestResult, { kind: "version_mismatch" }> | null {
  const header = response.headers.get(BUILD_MISMATCH_HEADER);
  if (header === null) return null;
  const parsed = parseBuildMismatchHeader(header);
  if (parsed === null) return null;
  return { kind: "version_mismatch", method, ...parsed };
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
  if (params.principalCapabilities !== undefined) {
    logger.debug("cli.request_principal_attached", {
      method: params.method,
      path: params.path,
      hasConversationCapability:
        params.principalCapabilities.conversation !== undefined,
      hasLaneCapability: params.principalCapabilities.lane !== undefined,
    });
  }

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

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok) {
    const skew = readBuildMismatch(response, params.method);
    if (skew !== null) return skew;
    return { kind: "ok", status: response.status, body };
  }

  return classifySkewedErrorBody(response, body, params.method);
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
  method: string,
): Exclude<CliRequestResult, { kind: "ok" }> {
  const classified = classifyErrorBody(response.status, body);
  if (classified.code === BUILD_SKEW_CODE) return classified;
  return readBuildMismatch(response, method) ?? classified;
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

  const text = await response.text();
  if (response.ok) {
    const skew = readBuildMismatch(response, params.method);
    if (skew !== null) return skew;
    return { kind: "ok", status: response.status, text };
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return classifySkewedErrorBody(response, body, params.method);
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
  "issues" | "code" | "reminders" | "instruction" | "rationale" | "details"
> {
  return {
    ...(result.issues ? { issues: result.issues } : {}),
    ...(result.code ? { code: result.code } : {}),
    ...(result.reminders ? { reminders: result.reminders } : {}),
    ...(result.instruction ? { instruction: result.instruction } : {}),
    ...(result.rationale ? { rationale: result.rationale } : {}),
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

  // The recovery command names the target revision, but only inside a command
  // string, and names neither the element nor the revision the read was
  // refused from. Every field of the refusal is rendered rather than a chosen
  // subset, so text carries the facts JSON does and a field added to the
  // refusal cannot reach one mode while silently missing the other.
  if (result.code === "historical_only" && isRecord(result.details)) {
    return Object.entries(result.details).map(
      ([field, value]) =>
        `  details.${field}: ${typeof value === "string" ? value : JSON.stringify(value)}`,
    );
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

function readBuildSkewDetails(
  details: CliErrorDetails | undefined,
): BuildSkewCliErrorDetails | null {
  if (!isRecord(details) || typeof details.serverBuild !== "string") {
    return null;
  }
  return {
    serverBuild: details.serverBuild,
    serverCliPath:
      typeof details.serverCliPath === "string" ? details.serverCliPath : null,
  };
}

/**
 * The refusal the server issues before running a skewed mutation. The message
 * can state what no post-response check could: the handler never ran, so the
 * caller can retry with the right binary instead of checking what committed.
 */
function buildSkewFailure(
  result: Extract<CliRequestResult, { kind: "error" }>,
  json: boolean,
): CliResult {
  const skew = readBuildSkewDetails(result.details);
  const cliBuild = formatBuildStamp(BUILD_INFO);
  const serverBuild = skew?.serverBuild ?? "a different build";
  const serverCliPath = skew?.serverCliPath ?? null;
  return failure({
    exitCode: EXIT_VERSION_MISMATCH,
    message: `refused before it ran: this cctl is build ${cliBuild}; the server is build ${serverBuild} — no changes were made`,
    detail: `  ${flattenDiagnosticText(result.error)}`,
    hint:
      serverCliPath === null
        ? "run `cctl doctor --server <url>` to print that server's cctl path, then invoke that binary"
        : `re-run with the cctl that server publishes: ${serverCliPath}`,
    code: BUILD_SKEW_CODE,
    ...(result.details ? { details: result.details } : {}),
    json,
  });
}

/**
 * The rendered-issue cap for a server refusal, matching the file-payload
 * refusals in `spec/write.ts`: past it the located lines stop being readable
 * evidence and start being a dump, while the envelope keeps every issue.
 */
const MAX_RENDERED_ISSUES = 5;

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
    return connectionFailure({
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
    return connectionFailure({
      message,
      hint: "run `cctl doctor` to check connectivity and auth",
      json,
    });
  }
  if (result.kind === "version_mismatch") {
    // Header-only skew means the server RAN the handler (a gated server
    // refuses mutations with `build_skew` instead, handled below). A discarded
    // read changed nothing; a mutation may already be committed server-side,
    // and claiming otherwise invites a re-run that double-commits.
    const isRead = result.method === "GET" || result.method === "HEAD";
    const outcome = isRead
      ? "so the response was discarded unread; nothing changed"
      : "and this server ran the request before reporting the skew — the mutation may have committed; verify server state before retrying";
    return failure({
      exitCode: EXIT_VERSION_MISMATCH,
      message: `this cctl is build ${result.cliBuild}; the server is build ${result.serverBuild}`,
      detail: `  every CC server publishes its own cctl at <its configDir>/bin/cctl — a binary from one server reads a\n  command surface the other does not have, ${outcome}`,
      hint: "run `cctl doctor --server <url>` to print that server's cctl path, then invoke that binary",
      json,
    });
  }
  if (result.code === BUILD_SKEW_CODE) return buildSkewFailure(result, json);
  const issues =
    result.issues?.filter((issue) => issue.message !== result.error) ?? [];
  const overflow = issues.length - MAX_RENDERED_ISSUES;
  const detailLines = [
    ...issueDetailLines(issues.slice(0, MAX_RENDERED_ISSUES)),
    ...(overflow > 0
      ? [
          `  …and ${overflow} more — the --json envelope carries all ${issues.length}`,
        ]
      : []),
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
