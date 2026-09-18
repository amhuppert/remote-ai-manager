import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { CORPUS_PNG_BASE64 } from "@/lib/conversation-checkpoints/fixtures/continuity-corpus";
import {
  installCodexFaultFixture,
  type CodexFaultKind,
} from "./checkpoint-handoff/codex-faults";
import { auditCodexRun } from "./checkpoint-handoff/codex-native-evidence";
import { codexToolFixture } from "./checkpoint-handoff/codex-tools";
import { probeModelSelection } from "./checkpoint-handoff/model-selection";
import { loadArtifactEnvironment } from "./checkpoint-handoff/artifact-environment";
import { prepareProbeEnvironment } from "./checkpoint-continuation/environment";
import {
  installClaudeHookFixture,
  assessClaudeHookWindow,
  observeClaudeHookWindow,
  type ClaudeHookSnapshot,
} from "./checkpoint-handoff/claude-hooks";
import {
  HANDOFF_EXPECTATIONS,
  HANDOFF_QUESTION_SUFFIX,
  HANDOFF_SOURCE,
} from "./checkpoint-handoff/corpus";
import type {
  CheckpointOperation,
  CheckpointPayload,
} from "@/lib/conversation-checkpoints/schemas";
import {
  captureAuditEvidence,
  gradeHandoffAnswer,
  originalAnswerForGrading,
  verifyCaptureBoundary,
  digest,
} from "./checkpoint-handoff/evidence";

function parseArgs(argv: string[]): {
  backend: "claude" | "codex";
  scope: "session" | "project";
  scenario: "cycles" | "failures";
  capture: boolean;
  runId: string;
  model: string | undefined;
  reasoning: string;
  failureCase: string | undefined;
  fromRun: string | undefined;
} {
  const flags = new Map<string, string>();
  const supported = [
    "--backend",
    "--scope",
    "--scenario",
    "--capture",
    "--model",
    "--reasoning",
    "--run-id",
    "--case",
    "--from-run",
  ];
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !supported.includes(flag) || !value || flags.has(flag))
      throw new Error(`invalid or repeated option ${flag}`);
    flags.set(flag, value);
  }
  const backend = flags.get("--backend");
  const scope = flags.get("--scope");
  const scenario = flags.get("--scenario");
  const capture = flags.get("--capture");
  if (backend !== "claude" && backend !== "codex")
    throw new Error("--backend claude|codex required");
  if (scope !== "session" && scope !== "project")
    throw new Error("--scope session|project required");
  if (scenario !== "cycles" && scenario !== "failures")
    throw new Error("--scenario cycles|failures required");
  if (scenario === "cycles" && capture !== "on" && capture !== "off")
    throw new Error("cycles requires --capture off|on");
  if (scenario === "failures" && capture !== undefined)
    throw new Error("--capture is only valid for cycles");
  const runId =
    flags.get("--run-id") ?? new Date().toISOString().replace(/[:.]/g, "-");
  if (!/^[a-zA-Z0-9_-]+$/.test(runId))
    throw new Error("run id must be a safe path component");
  return {
    backend,
    scope,
    scenario,
    capture: capture === "on",
    runId,
    model: flags.get("--model"),
    reasoning: flags.get("--reasoning") ?? "high",
    failureCase: flags.get("--case"),
    fromRun: flags.get("--from-run"),
  };
}

async function main() {
  if (process.argv.slice(2).length === 1 && process.argv[2] === "--help") {
    console.log(
      "Usage: run-checkpoint-handoff.sh --backend claude|codex --scope session|project --scenario cycles --capture off|on [--model ID] [--run-id ID]\n       run-checkpoint-handoff.sh --backend claude|codex --scope session|project --scenario failures [--case CASE] [--model ID]\n       run-checkpoint-handoff.sh --backend claude|codex --scope session|project --scenario failures --case artifact --from-run .cc/temp/checkpoint-probes/BACKEND/RUN/evidence/protected-evidence.json [--run-id ID]\n--reasoning none omits effort/reasoning parameters; explicit levels are preserved and validated.\nExplicit real-provider probes. Cycles cap ordinary/generation/capture at 12/6/0-or-3; failures at 16/12/8. Exit 0 passed, 1 failed, 2 incomplete.",
    );
    return;
  }
  const args = parseArgs(process.argv.slice(2));
  if (
    args.failureCase === "running-terminal" &&
    (args.backend !== "codex" || args.scope !== "session")
  )
    throw new Error("running-terminal requires Codex session scope");
  const root = path.resolve(
    ".cc/temp/checkpoint-probes",
    args.backend,
    `${args.runId}-${args.scope}`,
  );
  const artifactRun =
    args.scenario === "failures" && args.failureCase === "artifact";
  if (artifactRun !== (args.fromRun !== undefined))
    throw new Error(
      "--case artifact requires --from-run; other cases cannot reuse a run",
    );
  const artifactInput =
    artifactRun && args.fromRun
      ? loadArtifactEnvironment({
          fromRun: args.fromRun,
          runId: args.runId,
          backend: args.backend,
          scope: args.scope,
        })
      : null;
  if (!artifactRun && existsSync(root))
    throw new Error(
      "probe refuses to overwrite existing evidence; choose a fresh --run-id",
    );
  const environment =
    artifactInput?.environment ??
    prepareProbeEnvironment({
      tempRoot: path.resolve(".cc/temp"),
      backend: args.backend,
      runId: `${args.runId}-${args.scope}`,
      imageBase64: CORPUS_PNG_BASE64,
      modelSelection: probeModelSelection(
        args.backend,
        args.model,
        args.reasoning,
      ),
    });
  writeFileSync(
    path.join(environment.evidenceDir, "source-expectations.json"),
    JSON.stringify(HANDOFF_EXPECTATIONS, null, 2),
  );
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf-8",
  }).trim();
  const executablePath = process.argv[1];
  if (!executablePath) throw new Error("probe executable path unavailable");
  const executableSha256 = digest(readFileSync(executablePath, "utf-8"));
  await import("@/lib/agent-backends/registry");
  const { instrumentHandoffSubmissions } =
    await import("./checkpoint-handoff/instrumentation");
  const codexFaultKind: CodexFaultKind | null =
    args.backend === "codex" &&
    args.scenario === "failures" &&
    args.failureCase &&
    [
      "skip",
      "cancel",
      "output-limit",
      "provider-interruption",
      "execution-limit",
      "tool-violation",
      "output-limit-challenge",
    ].includes(args.failureCase)
      ? args.failureCase === "provider-interruption" ||
        args.failureCase === "execution-limit" ||
        args.failureCase === "tool-violation" ||
        args.failureCase === "output-limit-challenge"
        ? args.failureCase
        : "observe-only"
      : null;
  const codexFault = codexFaultKind
    ? await installCodexFaultFixture({
        fault: codexFaultKind,
        directory: environment.projectPath,
      })
    : null;
  const instrument = instrumentHandoffSubmissions(
    args.scenario,
    args.capture || args.scenario === "failures",
  );
  const frozen: unknown[] = [];
  const captureAudits: unknown[] = [];
  const handoffGrades: {
    cycle: number;
    grade: ReturnType<typeof gradeHandoffAnswer>;
  }[] = [];
  const captureFailures: string[] = [];
  const hookEvidence: unknown[] = [];
  let codexNativeEvidence: ReturnType<typeof auditCodexRun> | null = null;
  const hookFailures: string[] = [];
  let hookFixtureSha256: string | null = null;
  let result: unknown;
  let publicResult: unknown;
  let outcome = "incomplete";
  try {
    if (args.scenario === "cycles") {
      const hookFixture =
        args.backend === "claude"
          ? installClaudeHookFixture(environment)
          : null;
      hookFixtureSha256 = hookFixture?.fixtureSha256 ?? null;
      const initialHookSnapshot = hookFixture?.snapshot() ?? null;
      let beforeHookSnapshot: ClaudeHookSnapshot | null = null;
      let finalOrdinarySnapshot: ClaudeHookSnapshot | null = null;
      let finalOrdinaryRefDigest: string | undefined;
      const { runCheckpointContinuationProbe } =
        await import("./checkpoint-continuation/probe");
      const codexTools =
        args.backend === "codex"
          ? codexToolFixture(environment.projectPath)
          : null;
      const evidence = await runCheckpointContinuationProbe({
        backend: args.backend,
        scope: args.scope,
        environment,
        ledger: instrument.ledger,
        sourcePrompt: `${HANDOFF_SOURCE}${hookFixture ? `\nAlso leave this ordinary file action unfinished until explicitly requested: create ${JSON.stringify(hookFixture.pendingActionPath)}. Do not create it during any handoff.` : ""}`,
        continuityQuestionSuffix: HANDOFF_QUESTION_SUFFIX,
        answerForGrading: originalAnswerForGrading,
        deliverSourceCorpus: true,
        ...(codexTools
          ? {
              initialOrdinaryControl: {
                promptText: codexTools.promptText,
                onCompleted(backendRef: string | null) {
                  const effects = codexTools.snapshot();
                  hookEvidence.push({
                    kind: "codex-tool-positive",
                    sourceRefDigest: backendRef ? digest(backendRef) : null,
                    ...effects,
                  });
                  if (
                    !effects.positive ||
                    !effects.pendingAbsent ||
                    !backendRef
                  )
                    throw new Error(
                      "Codex writable-tool positive control or deferred-action precondition failed",
                    );
                },
              },
              afterCheckpoint(cycle: number, priorRef: string | null) {
                const effects = codexTools.snapshot();
                hookEvidence.push({
                  kind: "codex-capture-effects",
                  cycle,
                  sourceRefDigest: priorRef ? digest(priorRef) : null,
                  ...effects,
                });
                if (!effects.pendingAbsent)
                  hookFailures.push(`cycle ${cycle}: deferred action executed`);
              },
            }
          : {}),
        ...(hookFixture
          ? {
              beforeCheckpoint(cycle: number, priorRef: string | null) {
                beforeHookSnapshot = hookFixture.snapshot();
                if (!priorRef)
                  hookFailures.push(
                    `cycle ${cycle}: source reference absent for hook correlation`,
                  );
              },
              async afterCheckpoint(cycle: number, priorRef: string | null) {
                if (!beforeHookSnapshot)
                  throw new Error("checkpoint hook window was not opened");
                const kind = args.capture
                  ? ("capture-suppression" as const)
                  : ("ordinary-close" as const);
                const sourceRefDigest = priorRef ? digest(priorRef) : undefined;
                const assessed = await observeClaudeHookWindow(
                  hookFixture,
                  beforeHookSnapshot,
                  kind,
                  sourceRefDigest,
                );
                hookEvidence.push({
                  cycle,
                  kind,
                  sourceRefDigest,
                  beforeLogSha256: beforeHookSnapshot.logSha256,
                  afterLogSha256: assessed.snapshot.logSha256,
                  ...assessed,
                });
                hookFailures.push(
                  ...assessed.failures.map(
                    (failure) => `cycle ${cycle}: ${failure}`,
                  ),
                );
              },
              finalOrdinaryControl: {
                promptText: hookFixture.ordinaryToolPrompt,
                onCompleted(backendRef: string | null) {
                  if (!initialHookSnapshot)
                    throw new Error("initial hook snapshot missing");
                  finalOrdinarySnapshot = hookFixture.snapshot();
                  finalOrdinaryRefDigest = backendRef
                    ? digest(backendRef)
                    : undefined;
                  if (!backendRef)
                    hookFailures.push(
                      "final ordinary reference absent for positive-control correlation",
                    );
                  const assessed = assessClaudeHookWindow(
                    initialHookSnapshot,
                    finalOrdinarySnapshot,
                    "ordinary-positive",
                    finalOrdinaryRefDigest,
                  );
                  hookEvidence.push({
                    kind: "ordinary-positive",
                    sourceRefDigest: finalOrdinaryRefDigest,
                    finalSnapshot: finalOrdinarySnapshot,
                    ...assessed,
                  });
                  hookFailures.push(...assessed.failures);
                },
              },
            }
          : {}),
        ...(args.capture
          ? {
              handoff: {
                mode:
                  args.backend === "claude"
                    ? ("tool-disabled" as const)
                    : ("instruction-only" as const),
                sourcePrompt: HANDOFF_SOURCE,
                onFrozen(input: {
                  operation: CheckpointOperation;
                  payload: CheckpointPayload;
                  transcriptPath: string;
                }) {
                  frozen.push(input);
                  const handoff = input.operation.handoff;
                  if (!handoff) {
                    captureFailures.push(
                      "requested handoff absent from durable operation",
                    );
                    return;
                  }
                  const audit = captureAuditEvidence(
                    readFileSync(input.transcriptPath, "utf-8"),
                    handoff.captureId,
                  );
                  captureFailures.push(
                    ...verifyCaptureBoundary({
                      boundary: input.payload.sourceBasis.capturedThroughSeq,
                      auditSeqs: audit.auditSeqs,
                      seedText: input.payload.seedText,
                      seedSha256: input.payload.seedSha256,
                    }),
                  );
                  if (!handoff.modeEstablished)
                    captureFailures.push("capture mode not established");
                  if (!handoff.auditDurable)
                    captureFailures.push("capture audit not durable at freeze");
                  const priorRef =
                    input.operation.protectedReferences.priorBackendRef;
                  if (args.backend === "claude") {
                    if (!audit.emptyInventoryObserved)
                      captureFailures.push(
                        "no correlated empty Claude native inventory",
                      );
                    if (
                      !priorRef ||
                      !audit.initInventories.every(
                        (init) => init.sourceRefDigest === digest(priorRef),
                      )
                    )
                      captureFailures.push(
                        "capture init source reference does not match retired continuity",
                      );
                  }
                  captureAudits.push({
                    operationId: input.operation.id,
                    stage: handoff.stage,
                    omissionReason: handoff.omissionReason,
                    mode: handoff.requestedMode,
                    modeEstablished: handoff.modeEstablished,
                    sourceCoverage: handoff.sourceCoverage,
                    modelSelection: handoff.modelSelection,
                    usage: handoff.usage,
                    activity: handoff.activity,
                    contentHash: handoff.contentHash,
                    seedSha256: input.payload.seedSha256,
                    sourceBasis: input.payload.sourceBasis,
                    versions: input.payload.versions,
                    sectionBytes: input.payload.sectionBytes,
                    ...audit,
                  });
                },
              },
            }
          : {}),
      });
      if (hookFixture && finalOrdinarySnapshot) {
        const assessed = await observeClaudeHookWindow(
          hookFixture,
          finalOrdinarySnapshot,
          "ordinary-close",
          finalOrdinaryRefDigest,
        );
        hookEvidence.push({
          kind: "final-ordinary-close",
          sourceRefDigest: finalOrdinaryRefDigest,
          ...assessed,
        });
        hookFailures.push(...assessed.failures);
      }
      const { toPublicRunReport, assertNoProtectedLeak, protectedValues } =
        await import("./checkpoint-continuation/evidence");
      handoffGrades.push(
        ...evidence.cycles.map((cycle) => ({
          cycle: cycle.cycle,
          grade: gradeHandoffAnswer(
            cycle.answers.map((answer) => answer.answer).join("\n"),
          ),
        })),
      );
      if (args.backend === "codex") {
        codexNativeEvidence = auditCodexRun(
          evidence.transcriptPath,
          environment.evidenceDir,
        );
        const captureWindows = codexNativeEvidence.windows.filter(
          (window) => window.kind === "capture",
        );
        if (
          !codexNativeEvidence.transcriptComplete ||
          !codexNativeEvidence.windows.some(
            (window) =>
              window.positiveControl && window.coverage === "complete",
          )
        )
          captureFailures.push(
            "independent native tool-positive evidence incomplete",
          );
        if (
          captureWindows.length !== (args.capture ? 3 : 0) ||
          captureWindows.some(
            (window) =>
              window.coverage !== "complete" || window.callKinds.length > 0,
          )
        )
          captureFailures.push(
            "independent native capture coverage or abstention failed",
          );
      }
      result = evidence;
      publicResult = toPublicRunReport(evidence);
      assertNoProtectedLeak(
        JSON.stringify(publicResult),
        protectedValues(evidence),
      );
      outcome =
        handoffGrades.every((item) => item.grade.satisfied) &&
        captureFailures.length === 0 &&
        hookFailures.length === 0 &&
        evidence.outcome === "passed" &&
        evidence.cycles
          .flatMap((cycle) => cycle.answers)
          .every((answer) => answer.satisfied)
          ? "passed"
          : "failed";
      if (
        existsSync(
          path.join(environment.projectPath, HANDOFF_EXPECTATIONS.absentFile),
        )
      )
        outcome = "failed";
    } else if (artifactInput) {
      const { instrumentTaskRunnersForProbe } =
        await import("./checkpoint-continuation/instrumentation");
      instrumentTaskRunnersForProbe(instrument.ledger);
      const { runArtifactIndependence } =
        await import("./checkpoint-handoff/artifact");
      const artifactEvidence = await runArtifactIndependence(artifactInput);
      result = artifactEvidence;
      outcome = artifactEvidence.status;
      publicResult = {
        status: artifactEvidence.status,
        checks: artifactEvidence.checks,
        conversationId: artifactEvidence.conversationId,
        seedHashes: artifactEvidence.seedHashes,
        artifactDigest: digest(JSON.stringify(artifactEvidence.artifact)),
        priorBackendRefDigest: artifactEvidence.priorBackendRef
          ? digest(artifactEvidence.priorBackendRef.ref)
          : null,
        followingBackendRefDigest: artifactEvidence.followingBackendRef
          ? digest(artifactEvidence.followingBackendRef.ref)
          : null,
      };
    } else if (args.failureCase === "running-terminal") {
      const { runCodexTerminalProbe } =
        await import("./checkpoint-handoff/codex-terminal");
      const terminalEvidence = await runCodexTerminalProbe({
        environment,
        budget: instrument.budget,
      });
      result = terminalEvidence;
      outcome = terminalEvidence.status;
      publicResult = terminalEvidence;
    } else if (args.failureCase === "daemon-restart") {
      const { runDaemonRestartProbe } =
        await import("./checkpoint-handoff/restart");
      const restartEvidence = await runDaemonRestartProbe({
        backend: args.backend,
        scope: args.scope,
        environment,
        budget: instrument.budget,
      });
      result = restartEvidence;
      outcome = restartEvidence.status;
      const { records, ...metadata } = restartEvidence;
      publicResult = {
        ...metadata,
        records: records.map(({ body, ...record }) => ({
          ...record,
          bodySha256: digest(JSON.stringify(body)),
        })),
      };
    } else if (args.failureCase === "routes") {
      const { runHandoffRouteScenario } =
        await import("./checkpoint-handoff/route-scenario");
      const routeEvidence = await runHandoffRouteScenario({
        backend: args.backend,
        scope: args.scope,
        environment,
        budget: instrument.budget,
      });
      result = routeEvidence;
      outcome = routeEvidence.status;
      const { records, ...metadata } = routeEvidence;
      publicResult = {
        ...metadata,
        records: records.map(({ body, ...record }) => ({
          ...record,
          bodySha256: digest(JSON.stringify(body)),
        })),
      };
    } else {
      const { instrumentTaskRunnersForProbe } =
        await import("./checkpoint-continuation/instrumentation");
      instrumentTaskRunnersForProbe(instrument.ledger);
      const { runHandoffFailures, FAILURE_SCENARIOS } =
        await import("./checkpoint-handoff/failures");
      const selectedCase = FAILURE_SCENARIOS.find(
        (scenario) => scenario === args.failureCase,
      );
      if (args.failureCase && !selectedCase)
        throw new Error("unknown failure case");
      const failureEvidence = await runHandoffFailures({
        backend: args.backend,
        scope: args.scope,
        environment,
        ledger: instrument.ledger,
        ...(codexFault ? { codexFault } : {}),
        ...(selectedCase ? { cases: [selectedCase] } : {}),
      });
      result = failureEvidence;
      outcome = failureEvidence.status;
      publicResult = {
        ...failureEvidence,
        rows: failureEvidence.rows.map(({ reason, ...row }) => ({
          ...row,
          reasonSha256: digest(reason),
        })),
      };
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
    publicResult = {
      errorSha256: digest(JSON.stringify(result)),
      reason:
        "Probe incomplete; inspect protected evidence for the failing step.",
    };
  }
  const { stopAllConversationActors } =
    await import("@/lib/workflows/conversation/manager");
  try {
    await stopAllConversationActors();
  } catch (error) {
    outcome = "incomplete";
    captureFailures.push(
      "runtime cleanup failed; inspect protected cleanup evidence",
    );
    frozen.push({
      cleanupError: error instanceof Error ? error.message : String(error),
    });
  }
  const protectedPath = path.join(
    environment.evidenceDir,
    "protected-evidence.json",
  );
  const protectedEvidence = {
    environment,
    sourceHead,
    executableSha256,
    args,
    outcome,
    result,
    frozen,
    hookFixtureSha256,
    hookEvidence,
    codexNativeEvidence,
    hookFailures,
    captureResults: instrument.captureResults,
    accounting: instrument.budget.snapshot(),
  };
  writeFileSync(protectedPath, JSON.stringify(protectedEvidence, null, 2), {
    mode: 0o600,
  });
  chmodSync(protectedPath, 0o600);
  writeFileSync(
    path.join(environment.evidenceDir, "public-report.json"),
    JSON.stringify(
      {
        sourceHead,
        executableSha256,
        args,
        outcome,
        artifactIndependence:
          args.scenario === "cycles" && args.capture
            ? "pending separate artifact run"
            : artifactRun
              ? outcome
              : "covered by baseline cycles or not applicable",
        handoffGrades,
        captureAudits,
        captureFailures,
        hookFixtureSha256,
        hookEvidence,
        codexNativeEvidence,
        hookFailures,
        result: publicResult,
        evidenceSha256: digest(readFileSync(protectedPath, "utf-8")),
        accounting: instrument.budget.snapshot(),
        pendingActionAbsent: !existsSync(
          path.join(environment.projectPath, HANDOFF_EXPECTATIONS.absentFile),
        ),
      },
      null,
      2,
    ),
  );
  console.log(`${outcome}: ${environment.evidenceDir}`);
  process.exit(outcome === "passed" ? 0 : outcome === "failed" ? 1 : 2);
}
main().catch((error: unknown) => {
  console.error(error);
  process.exit(2);
});
