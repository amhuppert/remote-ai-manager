import type {
  AgentLogAnalysisReport,
  AgentLogComparisonReport,
  AgentTraceAnalysisReport,
} from "./schemas";
import type { LogAnalysisFinding } from "./types";

function value(value: unknown): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "number")
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return String(value);
}

function numberField(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const raw = source[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function recordArrayField(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown>[] {
  const raw = source[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

/**
 * Sentences that keep `state.read.timing` aggregates from reading as complete
 * distributions. The state store only logs a read once it crosses an emit
 * floor, so counts and percentiles derived from those rows describe the tail
 * above the floor — and the facade-versus-repo gap subtracts unconditional
 * per-repo timings from that censored numerator.
 */
function stateReadTailNotes(stateStore: Record<string, unknown>): {
  sentence: string;
  rowSuffix: string;
} {
  const floorMs = numberField(stateStore, "stateReadFloorMs");
  if (floorMs === null) {
    return {
      sentence:
        "tail sample: state.read.timing is logged only above an emit floor, so counts and p95 are tail statistics, not typical latency",
      rowSuffix: " (above-floor tail sample; faster reads unlogged)",
    };
  }
  return {
    sentence: `tail sample: state.read.timing is logged only at or above the ${value(floorMs)} ms floor, so counts and p95 are tail statistics, not typical latency`,
    rowSuffix: ` (>= ${value(floorMs)} ms tail sample; faster reads unlogged)`,
  };
}

function firstTraceCommand(
  findings: readonly LogAnalysisFinding[],
): string | null {
  for (const finding of findings) {
    const traceId = finding.traceIds[0];
    if (traceId) {
      return `bun run logs:analyze -- trace ${traceId} --format markdown`;
    }
  }
  return null;
}

function renderFindings(findings: readonly LogAnalysisFinding[]): string[] {
  if (findings.length === 0)
    return ["- No findings crossed configured thresholds."];
  return findings.map((finding) => {
    const evidence = finding.evidence
      .map(
        (item) =>
          `${item.label}=${value(item.value)}${item.unit ? ` ${item.unit}` : ""}`,
      )
      .join(", ");
    const traces =
      finding.traceIds.length > 0
        ? ` Trace IDs: ${finding.traceIds.join(", ")}.`
        : "";
    return `- **${finding.severity}** ${finding.title}. ${evidence}.${traces}`;
  });
}

export function renderLogAnalysisMarkdown(
  report: AgentLogAnalysisReport,
): string {
  const tailNotes = stateReadTailNotes(report.stateStore);
  const lines: string[] = [
    "# Command Center Log Analysis",
    "",
    "## Summary",
    `- Records analyzed: ${report.summary.recordsAnalyzed} / ${report.summary.recordsRead}`,
    `- Timed events: ${report.summary.timedEventCount}`,
    `- Requests: ${report.summary.requestCount}`,
    `- Warnings: ${report.summary.warnCount}`,
    `- Errors: ${report.summary.errorCount}`,
    "",
    "## Findings",
    ...renderFindings(report.findings),
    "",
    "## Top Slow Requests",
  ];

  for (const request of report.slowRequests.slice(0, 10)) {
    lines.push(
      `- ${value(request["key"])}: p95=${value(request["p95Ms"])} ms, max=${value(request["maxMs"])} ms, count=${value(request["count"])}`,
    );
  }
  if (report.slowRequests.length === 0)
    lines.push("- No request timings found.");

  lines.push("", "## Top Operation Hotspots");
  for (const hotspot of report.operationHotspots.slice(0, 10)) {
    const suffix =
      hotspot["message"] === "state.read.timing" ? tailNotes.rowSuffix : "";
    lines.push(
      `- ${value(hotspot["key"])}: p95=${value(hotspot["p95Ms"])} ms, total=${value(hotspot["totalMs"])} ms, count=${value(hotspot["count"])}${suffix}`,
    );
  }
  if (report.operationHotspots.length === 0) {
    lines.push("- No operation hotspots found.");
  }

  lines.push("", "## Duplicate Work");
  for (const duplicate of report.duplicateWork.slice(0, 10)) {
    lines.push(
      `- ${value(duplicate["signature"])} in ${value(duplicate["traceId"])}: count=${value(duplicate["count"])}, total=${value(duplicate["totalMs"])} ms`,
    );
  }
  if (report.duplicateWork.length === 0)
    lines.push("- No repeated work signatures found.");

  lines.push("", "## State Store");
  const slowAccessors = recordArrayField(report.stateStore, "slowAccessors");
  lines.push(
    `- Slow accessors: ${slowAccessors.length} (${tailNotes.sentence})`,
  );
  for (const accessor of slowAccessors.slice(0, 10)) {
    lines.push(
      `  - ${value(accessor["accessor"])}: count=${value(accessor["count"])}, p95=${value(accessor["p95Ms"])} ms, max=${value(accessor["maxMs"])} ms`,
    );
  }
  lines.push(
    `- Write queue groups: ${recordArrayField(report.stateStore, "writeQueue").length}`,
  );

  lines.push("", "## Budgets");
  lines.push(`- Violations: ${report.budgets.violationCount}`);
  for (const violation of report.budgets.violations.slice(0, 10)) {
    // A state-read breach is measured against the same censored p95 the State
    // Store section labels, so the qualifier has to travel with it.
    const suffix =
      violation["kind"] === "state-read" ? tailNotes.rowSuffix : "";
    lines.push(
      `- ${value(violation["kind"])}: ${value(violation["subject"])} observed=${value(violation["observed"])} ${value(violation["unit"])} > ceiling=${value(violation["ceiling"])} ${value(violation["unit"])}${suffix}`,
    );
  }
  if (report.budgets.violationCount === 0) {
    lines.push("- All observed metrics are within budget.");
  }

  lines.push("", "## External Commands");
  for (const command of report.externalCommands.slice(0, 10)) {
    lines.push(
      `- ${value(command["key"])}: p95=${value(command["p95Ms"])} ms, failures=${value(command["nonZeroExitCount"])}`,
    );
  }
  if (report.externalCommands.length === 0)
    lines.push("- No external command timings found.");

  lines.push("", "## SSE And Client Timing");
  lines.push(`- SSE event groups: ${report.sse.length}`);
  const clientTiming = report.clientTiming as { available?: boolean };
  lines.push(
    `- Client timing log available: ${clientTiming.available === true ? "yes" : "no"}`,
  );

  lines.push("", "## Recommended Next Commands");
  const traceCommand = firstTraceCommand(report.findings);
  if (traceCommand) {
    lines.push(`- ${traceCommand}`);
  } else {
    lines.push(
      "- Re-run with a larger log window if the symptom is intermittent.",
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderTraceAnalysisMarkdown(
  report: AgentTraceAnalysisReport,
): string {
  const lines = [
    `# Trace ${report.traceId}`,
    "",
    "## Findings",
    ...renderFindings(report.findings),
    "",
    "## Timing",
    `- Unexplained time: ${value(report.unexplainedTime["unexplainedMs"])} ms`,
    "",
    "## Exclusive Spans",
  ];

  for (const span of report.exclusiveSpans.slice(0, 10)) {
    lines.push(
      `- ${value(span["module"])}:${value(span["message"])} exclusive=${value(span["exclusiveMs"])} ms duration=${value(span["durationMs"])} ms`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderComparisonMarkdown(
  report: AgentLogComparisonReport,
): string {
  const lines = [
    "# Command Center Log Comparison",
    "",
    "## Findings",
    ...renderFindings(report.findings),
    "",
    "## Endpoint Deltas",
  ];

  for (const delta of report.endpointDeltas.slice(0, 10)) {
    lines.push(
      `- ${value(delta["key"])}: p95 delta=${value(delta["p95DeltaMs"])} ms (${value(delta["p95DeltaPercent"])}%)`,
    );
  }

  return `${lines.join("\n")}\n`;
}
