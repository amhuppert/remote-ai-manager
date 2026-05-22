import { parseTimedLogLine } from "./speedscope-export";

export interface TraceCoverageReport {
  totalTimed: number;
  covered: number;
  uncovered: number;
  uncoveredByModuleMessage: Array<{
    module: string;
    message: string;
    count: number;
  }>;
}

export interface AuditTraceCoverageOptions {
  /** Drop entries with timestamps earlier than this (ms since epoch). */
  sinceMs?: number;
}

export function auditTraceCoverage(
  lines: string[],
  opts: AuditTraceCoverageOptions = {},
): TraceCoverageReport {
  const counts = new Map<string, number>();
  let totalTimed = 0;
  let covered = 0;

  for (const line of lines) {
    const entry = parseTimedLogLine(line);
    if (entry === null) continue;

    if (opts.sinceMs !== undefined) {
      const ts = Date.parse(entry.timestamp);
      if (!Number.isFinite(ts) || ts < opts.sinceMs) continue;
    }

    totalTimed++;
    const traceId = entry.traceId;
    if (typeof traceId === "string" && traceId.length > 0) {
      covered++;
      continue;
    }

    const key = `${entry.module}\u0000${entry.message}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const uncoveredByModuleMessage = [...counts.entries()]
    .map(([key, count]) => {
      const [module, message] = key.split("\u0000");
      return { module: module ?? "", message: message ?? "", count };
    })
    .sort((a, b) => b.count - a.count || a.module.localeCompare(b.module));

  return {
    totalTimed,
    covered,
    uncovered: totalTimed - covered,
    uncoveredByModuleMessage,
  };
}
