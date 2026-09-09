/**
 * Entry point for the checkpoint continuation probe.
 *
 * Explicit and non-default by construction: it refuses to run without
 * `--backend`, it spends real provider credit, and it is never reached by any
 * registered validation command. Run it through
 * `scripts/probes/run-checkpoint-continuation.sh`, which bundles this module
 * for Node — `better-sqlite3` does not load under Bun, and the state store is
 * the whole point of the probe.
 *
 * The environment has to be prepared before any Command Center module loads,
 * because the config directory is resolved once at import time. That is why
 * the probe itself arrives through a dynamic import below.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CORPUS_PNG_BASE64 } from "@/lib/conversation-checkpoints/fixtures/continuity-corpus";

import {
  prepareProbeEnvironment,
  type ProbeModelSelection,
} from "./checkpoint-continuation/environment";

const BACKENDS = ["claude", "codex"] as const;
type ProbeBackend = (typeof BACKENDS)[number];

interface ProbeArgs {
  backend: ProbeBackend;
  scope: "session" | "project";
  runId: string;
  tempRoot: string;
  modelSelection: ProbeModelSelection | null;
}

function usage(): string {
  return [
    "usage: run-checkpoint-continuation.sh --backend <claude|codex> [--scope <session|project>] [--run-id <id>] [--model <id>] [--reasoning <level>]",
    "",
    "--model pins the model every call in the run uses, for an account whose",
    "supported models differ from CC's default. The run's evidence names it.",
    "",
    "Runs three real checkpoint cycles, one of them delivered from the message",
    "queue, against an isolated scratch datastore and worktree under .cc/temp.",
    "Spends real provider credit, bounded to 12 ordinary and 6 compaction calls.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): ProbeArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined) break;
    if (!flag.startsWith("--") || value === undefined) {
      throw new Error(`unexpected argument "${flag}"\n\n${usage()}`);
    }
    values.set(flag.slice(2), value);
  }
  const backend = values.get("backend");
  if (backend === undefined) {
    throw new Error(`--backend is required\n\n${usage()}`);
  }
  if (!BACKENDS.includes(backend as ProbeBackend)) {
    throw new Error(
      `--backend must be one of ${BACKENDS.join(", ")}\n\n${usage()}`,
    );
  }
  const scope = values.get("scope") ?? "session";
  if (scope !== "session" && scope !== "project") {
    throw new Error(`--scope must be session or project\n\n${usage()}`);
  }
  const modelId = values.get("model");
  return {
    backend: backend as ProbeBackend,
    scope,
    runId:
      values.get("run-id") ??
      new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
    tempRoot: values.get("temp-root") ?? path.resolve(".cc/temp"),
    modelSelection:
      modelId === undefined
        ? null
        : {
            modelId,
            parameters:
              backend === "codex"
                ? {
                    fast: "false",
                    reasoning: values.get("reasoning") ?? "high",
                  }
                : { effort: values.get("reasoning") ?? "high" },
          },
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const environment = prepareProbeEnvironment({
    tempRoot: args.tempRoot,
    backend: args.backend,
    runId: `${args.runId}-${args.scope}`,
    imageBase64: CORPUS_PNG_BASE64,
    modelSelection: args.modelSelection,
  });
  console.log(`probe scratch root: ${environment.root}`);

  const [{ runCheckpointContinuationProbe }, evidenceModule] =
    await Promise.all([
      import("./checkpoint-continuation/probe"),
      import("./checkpoint-continuation/evidence"),
    ]);
  const { assertNoProtectedLeak, protectedValues, toPublicRunReport } =
    evidenceModule;

  const evidence = await runCheckpointContinuationProbe({
    backend: args.backend,
    scope: args.scope,
    environment,
  });

  mkdirSync(environment.evidenceDir, { recursive: true });
  writeFileSync(
    path.join(environment.evidenceDir, "protected-evidence.json"),
    JSON.stringify(evidence, null, 2),
    { encoding: "utf-8", mode: 0o600 },
  );
  const publicReport = toPublicRunReport(evidence);
  const serialized = JSON.stringify(publicReport, null, 2);
  assertNoProtectedLeak(serialized, protectedValues(evidence));
  writeFileSync(
    path.join(environment.evidenceDir, "public-report.json"),
    serialized,
    "utf-8",
  );

  const totals = evidence.callTotals;
  const answers = evidence.cycles.flatMap((cycle) => cycle.answers);
  console.log(
    [
      `outcome: ${evidence.outcome}`,
      `backend: ${evidence.backend} scope: ${evidence.scope} model: ${evidence.modelSelection?.modelId ?? "CC default"}`,
      `descriptor checkpoint capability: shipped=${evidence.descriptorCheckpointCapability.shipped} overriddenForProbe=${evidence.descriptorCheckpointCapability.overridden}`,
      `calls: ${totals.ordinary} ordinary, ${totals.compaction} compaction`,
      `provider-reported cost: $${totals.providerReportedCostUsd.toFixed(4)} over ${totals.callsWithProviderReportedCost} calls`,
      `estimated cost: $${totals.estimatedCostUsd.toFixed(4)} over ${totals.callsWithEstimatedCost} calls by ${totals.costEstimators.join(", ") || "no estimator"}`,
      `${totals.callsWithUnavailableCost} calls report cost unavailable`,
      `continuity expectations satisfied: ${answers.filter((a) => a.satisfied).length}/${answers.length}`,
      ...evidence.failures.map((failure) => `FAILURE: ${failure}`),
      ...answers
        .filter((answer) => !answer.satisfied)
        .map(
          (answer) =>
            `UNMET: ${answer.expectationId} (${answer.kind}) missing=${answer.missing.join(",") || "-"} forbidden=${answer.forbidden.join(",") || "-"}`,
        ),
      `evidence: ${environment.evidenceDir}`,
    ].join("\n"),
  );
  return evidence.outcome === "passed" && answers.every((a) => a.satisfied)
    ? 0
    : 1;
}

main().then(
  (code) => {
    process.exit(code);
  },
  (error: unknown) => {
    console.error(error);
    process.exit(2);
  },
);
