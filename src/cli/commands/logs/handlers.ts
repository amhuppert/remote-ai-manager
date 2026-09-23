import {
  binaryArtifact,
  bytes,
  count,
  invocation,
  runner,
  type CommandSpec,
  type HandlerInput,
  type JsonValue,
  type Omission,
  type ReadHandler,
} from "cli-for-agents";
import { z } from "zod";
import { createLogger } from "@/lib/logging";
import { buildTrace } from "@/lib/logging/speedscope-export";
import {
  analyzeLogComparison,
  analyzeLogReport,
  buildTraceAnalysisReport,
  type LogAnalysisOptions,
} from "@/lib/logging/log-analysis/analysis";
import { resolveDefaultServerLogPath } from "@/lib/logging/log-analysis/default-paths";
import {
  DEFAULT_BUDGET_CONFIG,
  parseBudgetConfig,
} from "@/lib/logging/log-analysis/budgets";
import { parseServerLogLines } from "@/lib/logging/log-analysis/parser";
import { getErrorMessage } from "@/lib/shared/errors";
import type { CcErrorCode } from "../../framework/context";
import { ccErrors, type ccGlobalFlags } from "../../framework/family";
import {
  logTraceCommand,
  type logReportSpec,
  type logTraceSpec,
  type logCompareSpec,
} from "./definitions";

type Input<S extends CommandSpec> = HandlerInput<
  S,
  never,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type Read<S extends CommandSpec> = ReadHandler<
  S,
  never,
  typeof ccErrors.definitions,
  typeof ccGlobalFlags
>;
type AnyInput =
  | Input<typeof logReportSpec>
  | Input<typeof logTraceSpec>
  | Input<typeof logCompareSpec>;
interface Data {
  readonly report: JsonValue;
  readonly inputs: readonly string[];
  readonly diagnostics: readonly string[];
  readonly disclosure?: Readonly<Record<string, Omission>>;
}
const logger = createLogger("log-analysis");

function refusal(input: AnyInput) {
  const redirects = {
    project: "--project-name",
    session: "--session-name",
    conversation: "--conversation-id",
    server: "no server is contacted",
    token: "no server is contacted",
  };
  for (const key of [
    "project",
    "session",
    "conversation",
    "server",
    "token",
  ] as const) {
    if (input.ctx.globals[key] !== undefined)
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message: `Log analysis does not take --${key}; ${redirects[key]}.`,
        }),
      } as const;
  }
  for (const key of ["since", "until"] as const) {
    const value = input.ctx.flags[key];
    if (value !== undefined && !Number.isFinite(Date.parse(value)))
      return {
        ok: false,
        error: ccErrors.error("CC_USAGE", {
          message: `Invalid --${key} timestamp. Supply an ISO timestamp.`,
          details: { input: value },
          issues: [
            {
              code: "invalid_timestamp",
              path: ["flags", key],
              message: "Expected an ISO timestamp.",
            },
          ],
        }),
      } as const;
  }
  return undefined;
}
function options(input: AnyInput): LogAnalysisOptions {
  const flags = input.ctx.flags;
  return {
    generatedAt: new Date(input.ctx.clock.now()).toISOString(),
    filters: {
      includeSelf: flags["include-self"] === true,
      ...(flags.since === undefined
        ? {}
        : { sinceMs: Date.parse(flags.since) }),
      ...(flags.until === undefined
        ? {}
        : { untilMs: Date.parse(flags.until) }),
      ...(flags["project-name"] === undefined
        ? {}
        : { projectName: flags["project-name"] }),
      ...(flags["session-name"] === undefined
        ? {}
        : { sessionName: flags["session-name"] }),
      ...(flags["conversation-id"] === undefined
        ? {}
        : { conversationId: flags["conversation-id"] }),
      ...(flags.path === undefined ? {} : { path: flags.path }),
      ...(flags.action === undefined ? {} : { action: flags.action }),
    },
    thresholds: {
      top: flags.top,
      slowMs: flags["slow-ms"],
      hotspotMs: flags["hotspot-ms"],
    },
  };
}
async function read(input: AnyInput, path: string): Promise<string> {
  const content = await input.ctx.host.files.read(
    path,
    bytes(256 * 1024 * 1024),
    input.ctx.signal,
  );
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}
async function source(
  input: Input<typeof logReportSpec> | Input<typeof logTraceSpec>,
) {
  const path = input.ctx.flags.in;
  const paths =
    path === undefined ? (await resolveDefaultServerLogPath()).paths : [path];
  const raw = (await Promise.all(paths.map((item) => read(input, item)))).join(
    "\n",
  );
  return { paths, raw };
}
function jsonReport(report: unknown): JsonValue {
  // Domain report schemas contain optional values; serialize the JSON DTO before
  // crossing the library's stricter JSON-only boundary.
  return z.json().parse(JSON.parse(JSON.stringify(report)));
}
function failed(error: unknown) {
  const message = getErrorMessage(error);
  // Required diagnostics survive failed artifact delivery. One hundred Unicode
  // code points plus the prefix fit the protocol's 512-byte JSON reservation.
  const cause = Array.from(message.replace(/[\p{Cc}\p{Cs}]/gu, " "));
  const summary = cause.slice(0, 100).join("").trim() || "Unknown failure";
  logger.error("log_analysis.error", { error: message });
  return {
    ok: false,
    error: ccErrors.error("CC_OPERATION_FAILED", {
      message: `Log analysis failed: ${summary}${cause.length > 100 ? "…" : ""}`,
      details: { reason: message },
    }),
  } as const;
}

const reportRun = (speedscope: boolean) =>
  runner<
    Input<typeof logReportSpec>,
    Data | { inputs: readonly string[] },
    CcErrorCode
  >({
    async run(input) {
      const denied = refusal(input);
      if (denied) return denied;
      try {
        const selected = await source(input);
        const settings = options(input);
        if (speedscope) {
          const trace = buildTrace(selected.raw.split(/\r?\n/), {
            ...(settings.filters.sinceMs === undefined
              ? {}
              : { sinceMs: settings.filters.sinceMs }),
          });
          return {
            ok: true,
            binary: binaryArtifact<{ inputs: readonly string[] }>({
              bytes: new TextEncoder().encode(JSON.stringify(trace)),
              mediaType: "application/json",
              basename: "log-speedscope.json",
              summary: { inputs: selected.paths },
            }),
          };
        }
        const diagnostics: string[] = [];
        let budgetConfig = DEFAULT_BUDGET_CONFIG;
        try {
          budgetConfig = parseBudgetConfig(
            JSON.parse(await read(input, "scripts/log-budgets.json")),
          );
        } catch {
          diagnostics.push(
            "Budget configuration unavailable at scripts/log-budgets.json; using built-in defaults.",
          );
        }
        const clientPath = input.ctx.flags["client-log"];
        const report = analyzeLogReport(selected.raw, selected.paths[0] ?? "", {
          ...settings,
          budgetConfig,
          ...(clientPath === undefined
            ? {}
            : { clientLogRaw: await read(input, clientPath) }),
        });
        logger.info("log_analysis.complete", {
          command: "report",
          recordsAnalyzed: report.summary.recordsAnalyzed,
          inputCount: selected.paths.length,
        });
        return {
          ok: true,
          data: {
            report: jsonReport(report),
            inputs: selected.paths,
            diagnostics,
          },
        };
      } catch (error) {
        return failed(error);
      }
    },
  });
export const reportHandler: Read<typeof logReportSpec> = {
  run: reportRun(false),
  levels: { full: reportRun(false), speedscope: reportRun(true) },
};

const traceRun = (full: boolean, speedscope: boolean) =>
  runner<Input<typeof logTraceSpec>, Data | { traceId: string }, CcErrorCode>({
    async run(input) {
      const denied = refusal(input);
      if (denied) return denied;
      try {
        const selected = await source(input);
        const settings = options(input);
        const traceId = input.ctx.args["trace-id"];
        const report = buildTraceAnalysisReport(
          parseServerLogLines(selected.raw.split(/\r?\n/)).records,
          traceId,
          settings,
        );
        if (speedscope) {
          const trace = buildTrace(selected.raw.split(/\r?\n/), {
            traceId,
            ...(settings.filters.sinceMs === undefined
              ? {}
              : { sinceMs: settings.filters.sinceMs }),
          });
          return {
            ok: true,
            binary: binaryArtifact<{ traceId: string }>({
              bytes: new TextEncoder().encode(JSON.stringify(trace)),
              mediaType: "application/json",
              basename: "trace-speedscope.json",
              summary: { traceId },
            }),
          };
        }
        const disclosure: Record<string, Omission> = {};
        const reveal = invocation(logTraceCommand, {
          args: input.ctx.args,
          flags: input.ctx.flags,
          level: "full",
        });
        if (!full)
          for (const key of [
            "timeline",
            "inclusiveSpans",
            "exclusiveSpans",
            "duplicateWork",
            "warningsAndErrors",
            "findings",
          ] as const) {
            const total = report[key].length;
            report[key].splice(settings.thresholds.top);
            const totals = {
              returned: count(report[key].length),
              total: { kind: "known", count: count(total) },
            } as const;
            disclosure[key] =
              total > report[key].length
                ? { ...totals, truncated: true, reveal }
                : { ...totals, truncated: false };
          }
        logger.info("log_analysis.complete", {
          command: "trace",
          traceId,
          inputCount: selected.paths.length,
        });
        return {
          ok: true,
          data: {
            report: jsonReport(report),
            inputs: selected.paths,
            diagnostics: [],
            ...(full ? {} : { disclosure }),
          },
        };
      } catch (error) {
        return failed(error);
      }
    },
  });
export const traceHandler: Read<typeof logTraceSpec> = {
  run: traceRun(false, false),
  levels: { full: traceRun(true, false), speedscope: traceRun(true, true) },
};

const compareRun = runner<Input<typeof logCompareSpec>, Data, CcErrorCode>({
  async run(input) {
    const denied = refusal(input);
    if (denied) return denied;
    try {
      const before = {
        path: input.ctx.flags.before,
        raw: await read(input, input.ctx.flags.before),
      };
      const after = {
        path: input.ctx.flags.after,
        raw: await read(input, input.ctx.flags.after),
      };
      const report = analyzeLogComparison(before, after, options(input));
      logger.info("log_analysis.complete", { command: "compare" });
      return {
        ok: true,
        data: {
          report: jsonReport(report),
          inputs: [before.path, after.path],
          diagnostics: [],
        },
      };
    } catch (error) {
      return failed(error);
    }
  },
});
export const compareHandler: Read<typeof logCompareSpec> = {
  run: compareRun,
  levels: { full: compareRun },
};
