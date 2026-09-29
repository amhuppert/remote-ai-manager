import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  ModuleDiagnostic,
  Reporter,
  TestModule,
  TestSpecification,
  TestRunEndReason,
  Vitest,
} from "vitest/node";

interface TimingModule {
  readonly moduleId: string;
  readonly project: { readonly name: string };
  diagnostic(): ModuleDiagnostic;
  state(): string;
}

// Vitest's own reporter reads this adapter, but it is not in TestProject's
// public type. Missing support is reported as unavailable, never zero time.
export function projectTransformDuration(project: unknown): number | null {
  if (
    project === null ||
    typeof project !== "object" ||
    !("vitenode" in project)
  )
    return null;
  const server = project.vitenode;
  if (
    server === null ||
    typeof server !== "object" ||
    !("getTotalDuration" in server) ||
    typeof server.getTotalDuration !== "function"
  )
    return null;
  const duration: unknown = server.getTotalDuration();
  return typeof duration === "number" && Number.isFinite(duration)
    ? duration
    : null;
}

export function summarizeTestModules(
  root: string,
  modules: readonly TimingModule[],
) {
  return modules
    .map((module) => {
      const timing = module.diagnostic();
      return {
        file: path.relative(root, module.moduleId),
        project: module.project.name,
        state: module.state(),
        collectMs: timing.collectDuration,
        setupMs: timing.setupDuration,
        executionMs: timing.duration,
        environmentMs: timing.environmentSetupDuration,
        prepareMs: timing.prepareDuration,
        transformMs: null,
      };
    })
    .sort(
      (a, b) =>
        a.file.localeCompare(b.file) || a.project.localeCompare(b.project),
    );
}

/** Records selected files and observed phases without expanding success stdout. */
export default class TestTimingReporter implements Reporter {
  private startedAt = 0;
  private selected: { file: string; project: string }[] = [];
  private context?: Vitest;

  onInit(context: Vitest) {
    this.context = context;
  }

  onTestRunStart(specifications: readonly TestSpecification[]) {
    this.startedAt = performance.now();
    this.selected = specifications.map((spec) => ({
      file: path.relative(process.cwd(), spec.moduleId),
      project: spec.project.name,
    }));
  }

  onTestRunEnd(
    modules: readonly TestModule[],
    errors: readonly unknown[],
    reason: TestRunEndReason,
  ) {
    const directory = path.join(process.cwd(), ".cc/temp/validation-metrics");
    mkdirSync(directory, { recursive: true });
    const transforms = this.context?.projects.map(projectTransformDuration);
    const report = {
      version: 1,
      runId: process.env.CC_VALIDATION_RUN_ID ?? null,
      invocation: process.argv.slice(2),
      workerCeiling: process.env.CC_TEST_WORKERS ?? null,
      resolvedMaxWorkers: this.context?.config.maxWorkers ?? null,
      reason,
      unhandledErrors: errors.length,
      elapsedMs: performance.now() - this.startedAt,
      transformMs:
        transforms === undefined || transforms.some((value) => value === null)
          ? null
          : transforms.reduce<number>((sum, value) => sum + (value ?? 0), 0),
      selected: this.selected,
      modules: summarizeTestModules(process.cwd(), modules),
      note: "Transform is a run-level total and overlaps collection; per-module transform is unavailable (null). Phase durations must not be summed as independent wall time.",
    };
    writeFileSync(
      path.join(directory, `${Date.now()}-${randomUUID()}.json`),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
}
