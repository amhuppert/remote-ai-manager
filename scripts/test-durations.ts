/**
 * Rank test files by their execution time from Vitest's own results cache.
 *
 *   bun scripts/test-durations.ts [--limit 25]
 *
 * Vitest writes `node_modules/.vite/vitest/<hash>/results.json` after every
 * run with each file's execution duration and outcome (execution only: the
 * spawn, setup, and import cost of a file is not in it). After a full-suite
 * run the file covers the whole unit corpus, which makes it the cheapest
 * standing hit list for the slowest files.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export type CachedResultEntry = readonly [
  string,
  { readonly duration: number; readonly failed: boolean },
];

export interface DurationReport {
  readonly fileCount: number;
  readonly totalSeconds: number;
  readonly byProject: Record<
    string,
    { count: number; totalSeconds: number; medianSeconds: number }
  >;
  readonly slowest: ReadonlyArray<{
    file: string;
    project: string;
    seconds: number;
    failed: boolean;
  }>;
  readonly slowestShare: number;
  readonly failedFiles: readonly string[];
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function splitKey(key: string): { project: string; file: string } {
  const separator = key.indexOf(":");
  if (separator === -1) return { project: "", file: key };
  return { project: key.slice(0, separator), file: key.slice(separator + 1) };
}

export function rankTestDurations(
  entries: ReadonlyArray<CachedResultEntry>,
  limit: number,
): DurationReport {
  const rows = entries.map(([key, result]) => ({
    ...splitKey(key),
    key,
    seconds: result.duration / 1000,
    failed: result.failed,
  }));
  const totalSeconds = rows.reduce((sum, row) => sum + row.seconds, 0);
  const byProject: DurationReport["byProject"] = {};
  const perProject = new Map<string, number[]>();
  for (const row of rows) {
    const list = perProject.get(row.project) ?? [];
    list.push(row.seconds);
    perProject.set(row.project, list);
  }
  for (const [project, seconds] of perProject) {
    byProject[project] = {
      count: seconds.length,
      totalSeconds: seconds.reduce((sum, value) => sum + value, 0),
      medianSeconds: median(seconds),
    };
  }
  const slowest = [...rows]
    .sort((a, b) => b.seconds - a.seconds)
    .slice(0, Math.max(0, limit))
    .map(({ file, project, seconds, failed }) => ({
      file,
      project,
      seconds,
      failed,
    }));
  const slowestSeconds = slowest.reduce((sum, row) => sum + row.seconds, 0);
  return {
    fileCount: rows.length,
    totalSeconds,
    byProject,
    slowest,
    slowestShare: totalSeconds === 0 ? 0 : slowestSeconds / totalSeconds,
    failedFiles: rows.filter((row) => row.failed).map((row) => row.key),
  };
}

function findLatestResultsFile(root: string): string | undefined {
  const cacheRoot = path.join(root, "node_modules", ".vite", "vitest");
  let candidates: string[];
  try {
    candidates = readdirSync(cacheRoot).map((entry) =>
      path.join(cacheRoot, entry, "results.json"),
    );
  } catch {
    return undefined;
  }
  const existing = candidates.filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
  existing.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return existing[0];
}

function parseEntries(raw: string): CachedResultEntry[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return [];
  const results: unknown = Reflect.get(parsed, "results");
  if (!Array.isArray(results)) return [];
  const entries: CachedResultEntry[] = [];
  for (const item of results) {
    if (!Array.isArray(item) || item.length !== 2) continue;
    const [key, result] = item as [unknown, unknown];
    if (typeof key !== "string" || typeof result !== "object" || !result) {
      continue;
    }
    const duration: unknown = Reflect.get(result, "duration");
    const failed: unknown = Reflect.get(result, "failed");
    if (typeof duration !== "number") continue;
    entries.push([key, { duration, failed: failed === true }]);
  }
  return entries;
}

function formatReport(report: DurationReport, source: string): string {
  const lines = [
    `source: ${source}`,
    `files: ${report.fileCount}  execution total: ${report.totalSeconds.toFixed(0)}s`,
  ];
  for (const [project, stats] of Object.entries(report.byProject)) {
    lines.push(
      `  ${project}: ${stats.count} files, ${stats.totalSeconds.toFixed(0)}s, median ${stats.medianSeconds.toFixed(2)}s`,
    );
  }
  lines.push(
    `slowest ${report.slowest.length} files (${(report.slowestShare * 100).toFixed(0)}% of execution time):`,
  );
  for (const row of report.slowest) {
    lines.push(
      `  ${row.seconds.toFixed(1).padStart(7)}s  ${row.failed ? "FAIL " : ""}${row.project}:${row.file}`,
    );
  }
  if (report.failedFiles.length > 0) {
    lines.push(`failed files: ${report.failedFiles.length}`);
    for (const key of report.failedFiles) lines.push(`  ${key}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const limitIndex = process.argv.indexOf("--limit");
  const limit =
    limitIndex === -1
      ? 25
      : Number.parseInt(process.argv[limitIndex + 1] ?? "", 10);
  const source = findLatestResultsFile(process.cwd());
  if (!source) {
    console.error(
      "no Vitest results cache found under node_modules/.vite/vitest",
    );
    process.exit(1);
  }
  const report = rankTestDurations(
    parseEntries(readFileSync(source, "utf8")),
    Number.isInteger(limit) && limit > 0 ? limit : 25,
  );
  console.log(formatReport(report, path.relative(process.cwd(), source)));
}
