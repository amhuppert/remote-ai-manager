import { BUILD_INFO, formatBuildStamp } from "@/lib/build-info";
import { dispatchGroup } from "./dispatch";
import { fetchHelpContext } from "./help-context";
import {
  booleanFlagArgsForCommand,
  childEntriesOf,
  emptyValueFlagArgsForCommand,
  emptyValueFlagNames,
  helpEntryFor,
  helpJsonFor,
  isGroup,
  renderHelpText,
} from "./help-registry";
import type { HelpContextBlock } from "./help-render";
import type { CommandHelpEntry } from "./help-types";
import { pathKey } from "./help-types";
import {
  EXIT_OK,
  EXIT_USAGE,
  USAGE,
  ccTempPayloadAdvisory,
  checkFlags,
  failure,
  parseArgv,
  render,
  readSessionEnv,
  resolveToken,
  usageFailure,
  withClientReminder,
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
    session: flags.session ?? readSessionEnv(env),
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

function runVersion(
  flags: GlobalFlags,
  values: Record<string, string>,
): CliResult {
  const invalidFlags = checkFlags(values, "version", flags.json);
  if (invalidFlags) return invalidFlags;
  const cliBuild = formatBuildStamp(BUILD_INFO);
  return {
    exitCode: EXIT_OK,
    stdout: render(flags.json, `cctl ${cliBuild}\n`, { ok: true, cliBuild }),
    stderr: "",
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
  // Two-pass parse (doc 06): boolean classification is command-aware, but the
  // command is only known after parsing. A first "probe" parse with the global
  // boolean union yields the command path (leading positionals — command tokens
  // never follow a flag, so ambiguous flag kinds cannot corrupt them); the
  // authoritative parse then lets that command's value flags override boolean
  // declarations elsewhere while retaining unknown booleans for checkFlags.
  const probe = parseArgv(
    argv,
    undefined,
    new Set(emptyValueFlagNames().map((name) => `--${name}`)),
  );
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
          new Set(
            emptyValueFlagArgsForCommand(
              rewriteWorkflowLiveAlias(probe.positionals),
            ),
          ),
        );
  if (parsed.kind === "error") {
    // The parse failed, so flags.json is unavailable — honor a literal --json.
    return usageFailure(parsed.message, argv.includes("--json"));
  }
  const acceptsPassthrough =
    parsed.positionals[0] === "validate" && parsed.positionals[1] === "run";
  if (parsed.passthrough.length > 0 && !acceptsPassthrough) {
    const commandPath = parsed.positionals.join(" ") || "cctl";
    return usageFailure(
      `${commandPath} does not accept arguments after '--'`,
      parsed.flags.json,
    );
  }
  const result = await dispatchCli(parsed, env, host);

  // Location reminder for file-backed payloads, applied centrally so every
  // payload command (workflow/spec/charter/decisions/agent/ask) gets it without
  // threading the advisory through each success return. Only on a successful
  // run — a failed invocation's payload location is moot.
  const payloadPath = parsed.values["file"] ?? parsed.values["inputs"];
  if (result.exitCode === EXIT_OK && payloadPath !== undefined) {
    const advisory = ccTempPayloadAdvisory(payloadPath);
    if (advisory !== undefined) {
      return withClientReminder(result, parsed.flags.json, advisory);
    }
  }
  return result;
}

async function dispatchCli(
  parsed: Extract<ReturnType<typeof parseArgv>, { kind: "ok" }>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const { positionals, flags, values, lists, passthrough } = parsed;
  const command = positionals[0];

  // Help is intercepted before dispatch so every command gets it without
  // declaring it, and so `--help` never trips per-command checkFlags. The full
  // positional path resolves against the registry (doc 04 §3.1); `cctl help x y`
  // and `cctl x y --help` both resolve the node ["x","y"]. `help` itself is not
  // a registry entry, so it never reaches the root handler map.
  if (values["help"] === "true" || command === "help") {
    const helpPath = command === "help" ? positionals.slice(1) : positionals;
    return resolveHelp(helpPath, flags, env, host);
  }

  return dispatchGroup({
    group: [],
    rest: positionals,
    json: flags.json,
    handlers: {
      ask: async (rest) => {
        const { runAsk } = await import("./commands/ask");
        return runAsk(rest, flags, values, lists, env, host);
      },
      notify: async (rest) => {
        const { runNotify } = await import("./commands/notify");
        return runNotify(rest, flags, values, env, host);
      },
      docs: async (rest) => {
        const { runDocs } = await import("./commands/docs");
        return runDocs(rest, flags, values, env, host);
      },
      dev: async (rest) => {
        const { runDev } = await import("./commands/dev");
        return runDev(rest, flags, values, env, host);
      },
      fixture: async (rest) => {
        const { runFixture } = await import("./commands/fixture");
        return runFixture(rest, flags, values, env, host);
      },
      workflow: async (rest) => {
        const { runWorkflow } = await import("./commands/workflow");
        return runWorkflow(rest, flags, values, env, host);
      },
      charter: async (rest) => {
        const { runCharter } = await import("./commands/charter");
        return runCharter(rest, flags, values, env, host);
      },
      decisions: async (rest) => {
        const { runDecisions } = await import("./commands/decisions");
        return runDecisions(rest, flags, values, env, host);
      },
      agent: async (rest) => {
        const { runAgent } = await import("./commands/agent");
        return runAgent(rest, flags, values, env, host);
      },
      validate: async (rest) => {
        const { runValidate } = await import("./commands/validate");
        return runValidate(rest, passthrough, flags, values, env, host);
      },
      conversation: async (rest) => {
        const { runConversation } = await import("./commands/conversation");
        return runConversation(rest, flags, values, env, host);
      },
      ticket: async (rest) => {
        const { runTicket } = await import("./commands/ticket");
        return runTicket(rest, flags, values, lists, env, host);
      },
      memory: async (rest) => {
        const { runMemory } = await import("./commands/memory");
        return runMemory(rest, flags, values, lists, env, host);
      },
      notepad: async (rest) => {
        const { runNotepad } = await import("./commands/notepad");
        return runNotepad(rest, flags, values, env, host);
      },
      spec: async (rest) => {
        const { runSpec } = await import("./commands/spec");
        return runSpec(rest, flags, values, lists, env, host);
      },
      logs: async (rest) => {
        const { runLogs } = await import("./commands/logs");
        return runLogs(rest, flags, values, env, host);
      },
      doctor: async () => {
        const { runDoctor } = await import("./commands/doctor");
        return runDoctor(flags, values, env, host);
      },
      "exit-codes": async () => {
        const { runExitCodes } = await import("./commands/exit-codes");
        return runExitCodes(flags, values);
      },
      version: async () => runVersion(flags, values),
    },
  });
}
