import { z } from "zod";
import { getErrorMessage } from "@/lib/shared/errors";
import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { runAgent } from "./commands/agent";
import { runAsk } from "./commands/ask";
import { runCharter } from "./commands/charter";
import { runConversation } from "./commands/conversation";
import { runDecisions } from "./commands/decisions";
import { runDev } from "./commands/dev";
import { runDocs } from "./commands/docs";
import { runFixture } from "./commands/fixture";
import { runNotify } from "./commands/notify";
import { runSpec } from "./commands/spec";
import { runTicket } from "./commands/ticket";
import { runWorkflow } from "./commands/workflow";
import { fetchHelpContext } from "./help-context";
import {
  booleanFlagArgsForCommand,
  childEntriesOf,
  flagNamesFor,
  helpEntryFor,
  helpJsonFor,
  isGroup,
  renderHelpText,
} from "./help-registry";
import type { HelpContextBlock } from "./help-render";
import type { CommandHelpEntry } from "./help-types";
import { pathKey } from "./help-types";
import {
  EXIT_CONNECTION,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  USAGE,
  ccTempPayloadAdvisory,
  checkFlags,
  failure,
  parseArgv,
  render,
  resolveToken,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "./shared";

export {
  EXIT_CONNECTION,
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  EXIT_VERSION_MISMATCH,
} from "./shared";
export type {
  CliEnv,
  CliHost,
  CliResult,
  FetchInit,
  FetchLike,
} from "./shared";

const handshakeResponseSchema = z.object({
  serverBuild: z.string(),
  identity: z.object({
    project: z.string().nullable(),
    session: z.string().nullable(),
    conversation: z.string().nullable(),
  }),
  tokenValid: z.boolean(),
});

function helpResult(text: string, json: boolean): CliResult {
  return {
    exitCode: EXIT_OK,
    stdout: json ? `${JSON.stringify({ ok: true, usage: text })}\n` : text,
    stderr: "",
  };
}

/** Render a resolved registry entry as help — structured JSON or graph text. */
function registryHelpResult(
  entry: CommandHelpEntry,
  json: boolean,
  contextBlocks: HelpContextBlock[] = [],
): CliResult {
  return {
    exitCode: EXIT_OK,
    stdout: json
      ? `${JSON.stringify(helpJsonFor(entry, contextBlocks))}\n`
      : renderHelpText(entry, contextBlocks),
    stderr: "",
  };
}

/**
 * Best-effort dynamic help-context for a resolved entry (doc 04 §4.4). Fetches
 * only when the entry opts in (`dynamicContext`), a server URL + token resolve
 * from flags/env, AND the blocks would actually be rendered — a group node's
 * TEXT help is a pure index (§3.1) with no `context:` section, so fetching for
 * it would stall a common hub command for nothing. `fetchHelpContext` swallows
 * every failure to `[]`, so help never fails.
 */
async function maybeFetchHelpContext(
  entry: CommandHelpEntry,
  willRender: boolean,
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<HelpContextBlock[]> {
  if (entry.dynamicContext !== true || !willRender) return [];
  const server = flags.server ?? env["CC_SERVER_URL"];
  if (!server) return [];
  const { token } = await resolveToken(flags, env, host);
  if (token === null) return [];

  return fetchHelpContext(host, {
    server,
    token,
    command: pathKey(entry.path),
    project: flags.project ?? env["CC_PROJECT"] ?? null,
    session: flags.session ?? env["CC_SESSION"] ?? null,
    conversation: flags.conversation ?? env["CC_CONVERSATION_ID"] ?? null,
    executionId: env["CC_WORKFLOW_EXECUTION_ID"] ?? null,
    contextId: env["CC_WORKFLOW_CONTEXT_ID"] ?? null,
  });
}

/**
 * Resolve `--help` for a positional path against the help registry by
 * longest-prefix match (doc 04 §3.1). The registry is the sole source: an
 * entirely unknown root is the standard `unknown command` usage failure, and a
 * known group node with an unknown trailing subcommand is an exit-2 usage
 * failure whose hint lists the parent's children. When the resolved entry opts
 * into dynamic context, server-rendered blocks are appended best-effort (§4.4).
 */
/**
 * `workflow execution …` / `workflow exec …` are dispatch-rewrite aliases for
 * `workflow live …` (doc 06, D10). The rewrite must also apply to help lookup so
 * `cctl workflow execution get --help` resolves the one `workflow live` help node
 * (the aliases get no separate entries).
 */
function rewriteWorkflowLiveAlias(path: string[]): string[] {
  if (
    path[0] === "workflow" &&
    (path[1] === "execution" || path[1] === "exec")
  ) {
    return ["workflow", "live", ...path.slice(2)];
  }
  return path;
}

async function resolveHelp(
  rawHelpPath: string[],
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const helpPath = rewriteWorkflowLiveAlias(rawHelpPath);
  const first = helpPath[0];
  if (first === undefined || first === "help") {
    return helpResult(USAGE, json);
  }

  const entry = helpEntryFor(helpPath);
  if (!entry) {
    return usageFailure(`unknown command "${first}"`, json);
  }

  const leftover = helpPath.slice(entry.path.length);
  const group = isGroup(entry);
  if (leftover.length > 0 && group) {
    const parent = pathKey(entry.path);
    const childVerbs = childEntriesOf(entry.path).map((child) =>
      child.path.slice(entry.path.length).join(" "),
    );
    return failure({
      exitCode: EXIT_USAGE,
      message: `unknown ${parent} subcommand "${leftover.join(" ")}"`,
      hint: `${parent} subcommands: ${childVerbs.join(", ")}`,
      json,
    });
  }

  // Group-node TEXT help renders no `context:` section (§3.1), so only leaf
  // text and any JSON help can surface dynamic blocks.
  const willRender = json || !group;
  const contextBlocks = await maybeFetchHelpContext(
    entry,
    willRender,
    flags,
    env,
    host,
  );
  return registryHelpResult(entry, json, contextBlocks);
}

function runVersion(flags: GlobalFlags): CliResult {
  const cliBuild = formatBuildStamp(BUILD_INFO);
  return {
    exitCode: EXIT_OK,
    stdout: render(flags.json, `cctl ${cliBuild}\n`, { ok: true, cliBuild }),
    stderr: "",
  };
}

async function runDoctor(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const server = flags.server ?? env["CC_SERVER_URL"];
  if (!server) {
    return failure({
      exitCode: EXIT_USAGE,
      message:
        "cctl doctor: no server URL — pass --server or set CC_SERVER_URL",
      json,
    });
  }

  const { token, source: tokenSource } = await resolveToken(flags, env, host);
  const identity = {
    project: flags.project ?? env["CC_PROJECT"] ?? null,
    session: flags.session ?? env["CC_SESSION"] ?? null,
    conversation: flags.conversation ?? env["CC_CONVERSATION_ID"] ?? null,
  };

  const cliBuild = formatBuildStamp(BUILD_INFO);
  const url = new URL("/api/agent/handshake", server);
  for (const [key, value] of Object.entries(identity)) {
    if (value !== null) url.searchParams.set(key, value);
  }
  const headers: Record<string, string> = { "x-cc-cli-build": cliBuild };
  if (token !== null) headers["authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await host.fetch(url.toString(), { method: "GET", headers });
  } catch (error) {
    return failure({
      exitCode: EXIT_CONNECTION,
      message: `cctl doctor: cannot reach the CC server at ${server} — is the CC server running?`,
      detail: getErrorMessage(error),
      hint: "start the CC server, then re-run `cctl doctor`",
      json,
    });
  }

  if (response.status === 401) {
    const message =
      token === null
        ? "cctl doctor: no API token — pass --token, set CC_API_TOKEN, or run the CC server once to provision <configDir>/api-token"
        : `cctl doctor: the server rejected the API token (source: ${tokenSource})`;
    return failure({
      exitCode: EXIT_CONNECTION,
      message,
      hint: "pass --token or set CC_API_TOKEN to the server's <configDir>/api-token value, then re-run `cctl doctor`",
      json,
    });
  }
  if (!response.ok) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `cctl doctor: handshake failed (HTTP ${response.status})`,
      json,
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const parsed = handshakeResponseSchema.safeParse(body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message:
        "cctl doctor: unexpected handshake response — is this a CC server?",
      json,
    });
  }

  const { serverBuild, identity: echoedIdentity, tokenValid } = parsed.data;
  const buildMatch = serverBuild === cliBuild;
  const warning = buildMatch
    ? ""
    : `warning: cctl build differs from server (cli=${cliBuild} server=${serverBuild}) — transient across a server restart\n`;

  const identityLine = [
    `project=${echoedIdentity.project ?? "-"}`,
    `session=${echoedIdentity.session ?? "-"}`,
    `conversation=${echoedIdentity.conversation ?? "-"}`,
  ].join(" ");
  const humanStdout = [
    `server        ${server}`,
    `server build  ${serverBuild}`,
    `cli build     ${cliBuild}`,
    `identity      ${identityLine}`,
    `token         valid (source: ${tokenSource ?? "-"})`,
  ].join("\n");

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${humanStdout}\n`, {
      ok: true,
      server,
      serverBuild,
      cliBuild,
      buildMatch,
      identity: echoedIdentity,
      tokenValid,
      tokenSource,
    }),
    stderr: warning,
  };
}

/**
 * The CLI core: pure (argv, env, host) -> result, no process/IO access — all
 * side effects go through the injected host.
 */
export async function runCli(
  argv: string[],
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  // Two-pass parse (doc 06): the boolean-flag set is command-scoped, but the
  // command is only known after parsing. A first "probe" parse with the global
  // boolean union yields the command path (leading positionals — command tokens
  // never follow a flag, so ambiguous flag kinds cannot corrupt them); the
  // authoritative parse then uses that command's own boolean set so a flag can
  // be boolean for one command and value for another (e.g. `--config`).
  const probe = parseArgv(argv);
  const parsed =
    probe.kind === "error"
      ? probe
      : parseArgv(
          argv,
          new Set(
            booleanFlagArgsForCommand(
              rewriteWorkflowLiveAlias(probe.positionals),
            ),
          ),
        );
  if (parsed.kind === "error") {
    // The parse failed, so flags.json is unavailable — honor a literal --json.
    return usageFailure(parsed.message, argv.includes("--json"));
  }
  const result = await dispatchCli(parsed, env, host);

  // Soft location nudge for `--file` payloads, applied centrally so every
  // payload command (workflow/charter/decisions/agent/ask) gets it without
  // threading the advisory through each success return. Only on a successful
  // run — a failed invocation's payload location is moot.
  const fileFlag = parsed.values["file"];
  if (result.exitCode === EXIT_OK && fileFlag !== undefined) {
    const advisory = ccTempPayloadAdvisory(fileFlag);
    if (advisory !== undefined) {
      return { ...result, stderr: `${result.stderr}${advisory}` };
    }
  }
  return result;
}

async function dispatchCli(
  parsed: Extract<ReturnType<typeof parseArgv>, { kind: "ok" }>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const { positionals, flags, values, lists } = parsed;
  const command = positionals[0];

  // Help is intercepted before dispatch so every command gets it without
  // declaring it, and so `--help` never trips per-command checkFlags. The full
  // positional path resolves against the registry (doc 04 §3.1); `cctl help x y`
  // and `cctl x y --help` both resolve the node ["x","y"].
  if (values["help"] === "true" || command === "help") {
    const helpPath = command === "help" ? positionals.slice(1) : positionals;
    return resolveHelp(helpPath, flags, env, host);
  }

  if (command === "version") return runVersion(flags);
  if (command === "doctor") {
    const denied = checkFlags(values, flagNamesFor("doctor"), flags.json);
    if (denied) return denied;
    return runDoctor(flags, env, host);
  }

  if (command === "ask") {
    return runAsk(positionals.slice(1), flags, values, lists, env, host);
  }

  if (command === "notify") {
    return runNotify(positionals.slice(1), flags, values, env, host);
  }

  if (command === "docs") {
    return runDocs(positionals.slice(1), flags, values, env, host);
  }

  if (command === "dev") {
    return runDev(positionals.slice(1), flags, values, env, host);
  }

  if (command === "fixture") {
    return runFixture(positionals.slice(1), flags, values, env, host);
  }

  if (command === "workflow") {
    return runWorkflow(positionals.slice(1), flags, values, env, host);
  }

  if (command === "charter") {
    return runCharter(positionals.slice(1), flags, values, env, host);
  }

  if (command === "decisions") {
    return runDecisions(positionals.slice(1), flags, values, env, host);
  }

  if (command === "agent") {
    return runAgent(positionals.slice(1), flags, values, env, host);
  }

  if (command === "conversation") {
    return runConversation(positionals.slice(1), flags, values, env, host);
  }

  if (command === "ticket") {
    return runTicket(positionals.slice(1), flags, values, env, host);
  }

  if (command === "spec") {
    return runSpec(positionals.slice(1), flags, values, lists, env, host);
  }

  if (command === undefined) {
    return {
      exitCode: EXIT_USAGE,
      stdout: flags.json
        ? `${JSON.stringify({ ok: false, error: "missing command" })}\n`
        : "",
      stderr: USAGE,
    };
  }
  return usageFailure(`unknown command "${command}"`, flags.json);
}
