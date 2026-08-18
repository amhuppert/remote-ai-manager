import {
  runLogAnalysisCli,
  type LogAnalysisCliRuntime,
} from "@/lib/logging/log-analysis/cli";
import { dispatchGroup } from "../dispatch";
import { emitLarge, type ArtifactManifest } from "../disclosure";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  failure,
  render,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
} from "../shared";

/**
 * `cctl logs` — the CLI surface of the bounded log-analysis engine
 * (`src/lib/logging/log-analysis`, docs/design/cc-cli/09 §8).
 *
 * The engine owns every analysis decision: which records parse, what counts as
 * slow, how a trace is reconstructed, and where the default log lives. This
 * module owns only what the CLI contract owns — the registry-declared flags,
 * the exit taxonomy, and egress through the shared render/failure envelopes and
 * the disclosure primitive. Nothing here interprets a log record.
 */

type LogsVerb = "report" | "trace" | "compare";

/**
 * One registry-declared flag and the engine option it forwards to. The two
 * spellings differ where CC's kebab-case convention meets the engine's own
 * option names, so the mapping is data rather than a rename at each call site.
 * Global flags are absent by construction: only names listed here travel.
 */
interface EngineOption {
  readonly flag: string;
  readonly option: string;
  readonly kind: "value" | "boolean";
}

const ENGINE_OPTIONS: readonly EngineOption[] = [
  { flag: "in", option: "in", kind: "value" },
  { flag: "client-log", option: "client-log", kind: "value" },
  { flag: "before", option: "before", kind: "value" },
  { flag: "after", option: "after", kind: "value" },
  { flag: "since", option: "since", kind: "value" },
  { flag: "until", option: "until", kind: "value" },
  { flag: "project-name", option: "projectName", kind: "value" },
  { flag: "session-name", option: "sessionName", kind: "value" },
  { flag: "conversation-id", option: "conversationId", kind: "value" },
  { flag: "path", option: "path", kind: "value" },
  { flag: "action", option: "action", kind: "value" },
  { flag: "top", option: "top", kind: "value" },
  { flag: "slow-ms", option: "slow-ms", kind: "value" },
  { flag: "hotspot-ms", option: "hotspot-ms", kind: "value" },
  { flag: "include-self", option: "include-self", kind: "boolean" },
  { flag: "speedscope-out", option: "speedscope-out", kind: "value" },
];

/**
 * The engine labels its own diagnostics with the package script that used to be
 * its only entry point; inside `cctl` that name points at nothing the caller ran.
 */
const ENGINE_LABEL = "[logs:analyze] ";

/**
 * `logs` addresses no server, so every global identity flag is a no-op here —
 * and three of them (`--project`, `--session`, `--conversation`) shadow a record
 * filter with a near-identical name, where silently ignoring one would report on
 * records the caller believes were excluded.
 */
const GLOBAL_FLAG_REDIRECTS: Readonly<Record<string, string>> = {
  project: "--project-name",
  session: "--session-name",
  conversation: "--conversation-id",
  server: "no server is contacted",
  token: "no server is contacted",
};

function globalFlagRefusal(
  command: string,
  values: Record<string, string>,
  json: boolean,
): CliResult | null {
  for (const [flag, redirect] of Object.entries(GLOBAL_FLAG_REDIRECTS)) {
    if (values[flag] === undefined) continue;
    return usageFailure(
      `${command} analyzes local log files and does not take --${flag} (${redirect})`,
      json,
    );
  }
  return null;
}

interface EngineRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function withoutEngineLabel(line: string): string {
  return line.startsWith(ENGINE_LABEL) ? line.slice(ENGINE_LABEL.length) : line;
}

function engineDiagnosticLines(stderr: string): string[] {
  return stderr
    .split("\n")
    .map((line) => withoutEngineLabel(line.trimEnd()))
    .filter((line) => line !== "");
}

function engineArgs(input: {
  readonly verb: LogsVerb;
  readonly positionals: readonly string[];
  readonly values: Record<string, string>;
  readonly json: boolean;
}): string[] {
  // `--json` is the CC selector for serialization, so the engine's own format
  // option is derived from it rather than exposed a second time.
  const args: string[] = [
    input.verb,
    ...input.positionals,
    "--format",
    input.json ? "json" : "markdown",
  ];
  for (const option of ENGINE_OPTIONS) {
    const value = input.values[option.flag];
    if (value === undefined) continue;
    if (option.kind === "boolean") args.push(`--${option.option}`);
    else args.push(`--${option.option}`, value);
  }
  return args;
}

/**
 * Run the engine against the CLI host. Reads and writes go through the host, so
 * a test drives the whole command without a filesystem; the engine keeps its own
 * default log discovery, which is the one path the CLI never names.
 */
async function runEngine(
  host: CliHost,
  env: CliEnv,
  args: readonly string[],
): Promise<EngineRun> {
  let stdout = "";
  let stderr = "";
  const runtime: LogAnalysisCliRuntime = {
    env,
    cwd: () => ".",
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
      },
    },
    async readFile(filePath: string) {
      const content = await host.readTextFile(filePath);
      if (content === null) throw new Error(`cannot read ${filePath}`);
      return content;
    },
    async writeFile(filePath: string, content: string) {
      const write = host.writeTextFile;
      if (write === undefined) {
        throw new Error(`cannot write ${filePath}: this CLI host cannot write`);
      }
      await write(filePath, content);
    },
  };
  const exitCode = await runLogAnalysisCli([...args], runtime);
  return { exitCode, stdout, stderr };
}

/**
 * The engine's codes are its own: `2` for a malformed option, `3` for nothing to
 * analyze (an empty filter result, an absent trace), `1` otherwise. Only `2`
 * survives into the CC taxonomy — CC reserves `3` for connection/auth failures
 * whose recovery is `cctl doctor`, and a log that does not contain the requested
 * work is an ordinary operation failure.
 */
function cliExitFor(engineExitCode: number): number {
  return engineExitCode === 2 ? EXIT_USAGE : EXIT_OPERATION_FAILED;
}

function engineFailure(run: EngineRun, json: boolean): CliResult {
  const lines = engineDiagnosticLines(run.stderr);
  const message = lines[lines.length - 1] ?? "log analysis failed";
  const detail = lines.slice(0, -1).map((line) => `  ${line}`);
  return failure({
    exitCode: cliExitFor(run.exitCode),
    message,
    ...(detail.length > 0 ? { detail: detail.join("\n") } : {}),
    json,
  });
}

/** The receipt that stands in for content stdout does not carry. */
function artifactText(command: string, manifest: ArtifactManifest): string {
  const reason =
    manifest.reason === "requested"
      ? "written to --out"
      : "stdout budget exceeded";
  return `${[
    `${command}\t${reason}`,
    `artifact: ${manifest.path}`,
    `format: ${manifest.format}`,
    `bytes: ${manifest.bytes}`,
    `sha256: ${manifest.sha256}`,
  ].join("\n")}\n`;
}

function unwritableFailure(
  command: string,
  outcome: { readonly reason: string; readonly path: string },
  json: boolean,
): CliResult {
  return outcome.reason === "host_cannot_write"
    ? failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `${command}: this CLI host cannot write artifact files`,
        code: "write_unavailable",
        json,
      })
    : failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `${command}: could not write ${JSON.stringify(outcome.path)}`,
        code: "write_failed",
        json,
      });
}

/**
 * Emit one analysis. A whole-log report or a long trace is exactly the payload
 * that truncates a pipe mid-envelope, so the bytes go through the disclosure
 * primitive: inline while they fit the stdout budget, otherwise into a file
 * whose manifest stdout carries in their place. `--out` asks for the file
 * unconditionally.
 */
async function emitAnalysis(input: {
  readonly host: CliHost;
  readonly json: boolean;
  readonly command: string;
  readonly namePrefix: string;
  readonly content: string;
  readonly outPath: string | undefined;
  readonly stderr: string;
}): Promise<CliResult> {
  const { host, json, command } = input;
  const format = json ? "json" : "markdown";
  const outcome = await emitLarge(host, input.content, {
    format,
    namePrefix: input.namePrefix,
    ...(input.outPath !== undefined
      ? { path: input.outPath, force: "requested" as const }
      : {}),
  });

  if (outcome.kind === "unwritable") {
    return unwritableFailure(command, outcome, json);
  }
  if (outcome.kind === "artifact") {
    return {
      exitCode: EXIT_OK,
      stdout: render(json, artifactText(command, outcome.manifest), {
        ok: true,
        command,
        storage: "artifact",
        artifact: outcome.manifest,
      }),
      stderr: input.stderr,
    };
  }

  if (!json) {
    const text = outcome.text.endsWith("\n")
      ? outcome.text
      : `${outcome.text}\n`;
    return {
      exitCode: EXIT_OK,
      stdout: render(false, text, { ok: true }),
      stderr: input.stderr,
    };
  }

  let report: unknown;
  try {
    report = JSON.parse(outcome.text);
  } catch {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: `${command}: the log analysis returned output this CLI cannot read as JSON`,
      code: "malformed_analysis",
      json,
    });
  }
  return {
    exitCode: EXIT_OK,
    stdout: render(true, "", { ok: true, report }),
    stderr: input.stderr,
  };
}

async function runAnalysis(input: {
  readonly host: CliHost;
  readonly env: CliEnv;
  readonly json: boolean;
  readonly verb: LogsVerb;
  readonly positionals: readonly string[];
  readonly values: Record<string, string>;
}): Promise<CliResult> {
  const { host, json, verb } = input;
  const command = `logs ${verb}`;
  const refused = globalFlagRefusal(command, input.values, json);
  if (refused) return refused;

  const run = await runEngine(
    host,
    input.env,
    engineArgs({
      verb,
      positionals: input.positionals,
      values: input.values,
      json,
    }),
  );
  if (run.exitCode !== 0) return engineFailure(run, json);

  const diagnostics = engineDiagnosticLines(run.stderr);
  return emitAnalysis({
    host,
    json,
    command,
    namePrefix: `logs-${verb}`,
    content: run.stdout,
    outPath: input.values["out"],
    stderr: diagnostics.length > 0 ? `${diagnostics.join("\n")}\n` : "",
  });
}

export async function runLogs(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["logs"],
    rest,
    json: flags.json,
    handlers: {
      report: (r) => runLogsReport(r, flags, values, env, host),
      trace: (r) => runLogsTrace(r, flags, values, env, host),
      compare: (r) => runLogsCompare(r, flags, values, env, host),
    },
  });
}

async function runLogsReport(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "logs report", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("logs report takes no positional arguments", json);
  }
  return runAnalysis({
    host,
    env,
    json,
    verb: "report",
    positionals: [],
    values,
  });
}

async function runLogsTrace(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "logs trace", json);
  if (denied) return denied;
  const traceId = rest[0];
  if (traceId === undefined) {
    return usageFailure("logs trace requires a <traceId> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("logs trace takes a single <traceId> argument", json);
  }
  return runAnalysis({
    host,
    env,
    json,
    verb: "trace",
    positionals: [traceId],
    values,
  });
}

async function runLogsCompare(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "logs compare", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("logs compare takes no positional arguments", json);
  }
  return runAnalysis({
    host,
    env,
    json,
    verb: "compare",
    positionals: [],
    values,
  });
}
