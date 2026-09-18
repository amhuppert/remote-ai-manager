/** Explicit provider probes. Never imported by registered unit validation. */
import type {
  installCodexFaultFixture,
  CodexFaultEvidence,
} from "./codex-faults";
import { codexCaptureStarted } from "./codex-capture-start";
import { randomUUID, createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { CHECKPOINT_CAPTURE_LIMITS } from "@/lib/conversation-checkpoints/budget";
import { getConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/service-factory";
import type { CheckpointHandoffReceipt } from "@/lib/conversation-checkpoints/schemas";
import {
  installClaudeFaultFixture,
  type ClaudeFaultEvidence,
} from "./claude-faults";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import {
  createProjectConversationRecord,
  createSessionRow,
  getStateDb,
  getConversation,
  getProjectConversation,
} from "@/lib/state-store";
import { checkpointScopeKeyForStoreIdentity } from "@/lib/workflows/conversation/actor-input-loader";
import {
  cancelConversationCheckpoint,
  skipConversationCheckpointHandoff,
  startConversationCheckpoint,
  stopConversationActor,
  submitConversationTurn,
} from "@/lib/workflows/conversation/manager";
import type { ConversationAddress } from "@/lib/workflows/conversation/turn-spec";
import type { ProbeCallLedger } from "../checkpoint-continuation/budget";
import {
  assertIsolated,
  type ProbeEnvironment,
} from "../checkpoint-continuation/environment";

type FailureCase =
  | "tool-violation"
  | "output-limit-challenge"
  | "pending-action"
  | "skip"
  | "cancel"
  | "output-limit"
  | "output-limit-injected"
  | "execution-limit"
  | "setup-control-rejection"
  | "provider-interruption";
export const FAILURE_SCENARIOS = [
  "tool-violation",
  "output-limit-challenge",
  "pending-action",
  "skip",
  "cancel",
  "output-limit",
  "output-limit-injected",
  "execution-limit",
  "setup-control-rejection",
  "provider-interruption",
  "daemon-restart",
] as const;
export type FailureScenario = (typeof FAILURE_SCENARIOS)[number];
export interface FailureCaseEvidence {
  scenario: string;
  status: "passed" | "failed" | "incomplete";
  reason: string;
  conversationId: string | null;
  operationId: string | null;
  phase: string | null;
  modeEstablished: boolean | null;
  captureSubmitted: boolean | null;
  executionSettled: boolean | null;
  omissionReason: string | null;
  canaryAbsent: boolean | null;
  continued: boolean | null;
  transcriptSha256: string | null;
  seedSha256: string | null;
  cleanupSettled: boolean | null;
  usage: CheckpointHandoffReceipt["usage"];
  activity: CheckpointHandoffReceipt["activity"];
  sourceRefDigest: string | null;
  followingRefDigest: string | null;
  faultEvidence: ClaudeFaultEvidence | null;
  codexFaultEvidence: CodexFaultEvidence | null;
  elapsedMs: number;
}

export interface FailureProbeOptions {
  backend: "claude" | "codex";
  scope: "session" | "project";
  environment: ProbeEnvironment;
  /** The CLI installs provider-boundary generation and capture guards first. */
  ledger: ProbeCallLedger;
  cases?: readonly FailureScenario[];
  codexFault?: Awaited<ReturnType<typeof installCodexFaultFixture>>;
}

function emptyEvidence(scenario: string, reason: string): FailureCaseEvidence {
  return {
    scenario,
    status: "incomplete",
    reason,
    conversationId: null,
    operationId: null,
    phase: null,
    modeEstablished: null,
    captureSubmitted: null,
    executionSettled: null,
    omissionReason: null,
    canaryAbsent: null,
    continued: null,
    transcriptSha256: null,
    seedSha256: null,
    cleanupSettled: null,
    usage: null,
    activity: null,
    sourceRefDigest: null,
    followingRefDigest: null,
    faultEvidence: null,
    codexFaultEvidence: null,
    elapsedMs: 0,
  };
}

/**
 * Limit challenges request difficult/large working state in an ordinary source
 * turn. They leave the production capture prompt and numeric bounds untouched.
 * A provider that responds below the bound has NOT certified the bound.
 */
function sourcePrompt(scenario: FailureCase, canary: string): string {
  const base = `This is an isolated checkpoint probe. Record the next pending ordinary action: create ${canary} containing PENDING-ACTION-CANARY. Do not create it yet; wait for a later explicit ordinary request. Do not call tools on this turn. Exact issue ID is CC-HANDOFF-781. The failed approach was blind queue replay because acceptance was uncertain. The belief that the worker is dead is unverified, not an observed fact. Reply with a short acknowledgement.`;
  if (scenario === "output-limit") {
    const identifiers = Array.from(
      { length: 220 },
      (_, index) =>
        `STATE-${index.toString().padStart(4, "0")}-迁移🚧再開🔒識別-${createHash("sha256").update(String(index)).digest("hex").slice(0, 12)}`,
    );
    return `${base}\nThe following exact identifiers are outstanding work items. A later working-state handoff must preserve each identifier verbatim in its plan; do not replace them with a range or digest.\n${identifiers.join("\n")}`;
  }
  if (scenario === "execution-limit") {
    return `${base}\nThe pending analysis is to enumerate and evaluate all possible permutations of a 20-item dependency order with competing resource limits, then record the optimal order. Before producing any later working-state handoff, think carefully through that outstanding analysis without tools. Do not claim this analysis has already been completed.`;
  }
  return base;
}

async function runCase(
  options: FailureProbeOptions,
  scenario: FailureCase,
): Promise<FailureCaseEvidence> {
  const start = Date.now();
  const { environment, backend, scope, ledger } = options;
  const result = emptyEvidence(scenario, "scenario did not settle");
  const conversationId = randomUUID();
  const sessionName =
    scope === "session"
      ? `handoff-failure-${scenario}-${conversationId.slice(0, 8)}`
      : null;
  const { getTranscriptPath } = await import("@/lib/prompt/transcript");
  const transcriptPath = await getTranscriptPath(conversationId);
  const canary = path.join(
    environment.projectPath,
    `pending-${conversationId}.txt`,
  );
  const now = new Date().toISOString();
  const conversation = makeConversationState({
    id: conversationId,
    agentBackend: backend,
    transcriptPath,
    status: "awaiting",
    createdAt: now,
    lastActivityAt: now,
  });
  if (sessionName === null) {
    await createProjectConversationRecord(
      environment.projectPath,
      conversation,
    );
  } else {
    await createSessionRow(
      environment.projectPath,
      sessionStateSchema.parse({
        sessionName,
        worktreePath: environment.projectPath,
        branchName: "main",
        createdAt: now,
        lastActivityAt: now,
        conversations: [conversation],
      }),
    );
  }
  const address: ConversationAddress = {
    projectPath: environment.projectPath,
    target:
      sessionName === null
        ? {
            scope: "project",
            projectName: environment.projectName,
            conversationId,
          }
        : {
            scope: "session",
            projectName: environment.projectName,
            sessionName,
            conversationId,
          },
  };
  const key = checkpointScopeKeyForStoreIdentity({
    projectPath: environment.projectPath,
    sessionName: sessionName ?? "__project__",
    conversationId,
  });
  const repo = getConversationCheckpointsRepo();
  result.conversationId = conversationId;
  let fault: Awaited<ReturnType<typeof installClaudeFaultFixture>> | null =
    null;
  const readBackendDigest = async () => {
    const row =
      sessionName === null
        ? await getProjectConversation(environment.projectPath, conversationId)
        : await getConversation(
            environment.projectPath,
            sessionName,
            conversationId,
          );
    return row?.backendRef
      ? createHash("sha256").update(row.backendRef.ref).digest("hex")
      : null;
  };

  async function ordinary(promptText: string): Promise<boolean> {
    const token = ledger.admit("ordinary", `failure:${scenario}`, backend);
    const admitted = await submitConversationTurn({
      binding: { kind: "durable", address },
      turn: { promptText },
    });
    if (admitted.kind !== "accepted") return false;
    const settled = await admitted.turn.completed;
    const outcome = settled.outcome;
    ledger.settle(token, {
      costUsd:
        outcome.kind === "call_result"
          ? (outcome.result.usage?.costUsd ?? null)
          : null,
    });
    return (
      outcome.kind === "call_result" &&
      outcome.result.outcome.kind === "completed"
    );
  }

  try {
    if (
      backend === "claude" &&
      (scenario === "setup-control-rejection" ||
        scenario === "provider-interruption" ||
        scenario === "output-limit-injected" ||
        scenario === "execution-limit")
    ) {
      fault = await installClaudeFaultFixture({
        directory: path.join(environment.root, "claude-faults", conversationId),
        fault: scenario,
      });
    }
    if (!(await ordinary(sourcePrompt(scenario, canary)))) {
      result.reason = "source continuity turn failed; capture not attempted";
      return result;
    }
    if (existsSync(canary)) {
      result.status = "failed";
      result.reason =
        "ordinary setup unexpectedly performed the pending action";
      return result;
    }
    result.sourceRefDigest = await readBackendDigest();
    fault?.arm();
    options.codexFault?.arm();
    const started = await startConversationCheckpoint({
      address,
      requestId: randomUUID(),
      handoff: {
        mode: backend === "claude" ? "tool-disabled" : "instruction-only",
      },
    });
    if (started.kind === "refused") {
      result.reason = `checkpoint refused: ${started.refusal.code}`;
      return result;
    }
    result.operationId = started.operation.id;
    if (scenario === "skip" || scenario === "cancel") {
      const deadline = Date.now() + CHECKPOINT_CAPTURE_LIMITS.executionMs;
      while (Date.now() < deadline) {
        const operation = await repo.getOperation(key, started.operation.id);
        const captureId = operation?.handoff?.captureId;
        // The durable native init distinguishes an allocated restricted Query
        // from "running", which precedes suppression and provider dispatch.
        const initialized =
          backend === "codex"
            ? captureId !== undefined &&
              existsSync(transcriptPath) &&
              codexCaptureStarted(
                readFileSync(transcriptPath, "utf8"),
                captureId,
              )
            : captureId !== undefined &&
              existsSync(transcriptPath) &&
              readFileSync(transcriptPath, "utf8")
                .split("\n")
                .some(
                  (line) =>
                    line.includes(JSON.stringify(captureId)) &&
                    line.includes('"subtype":"init"'),
                );
        if (operation?.handoff?.stage === "running" && initialized) {
          if (scenario === "skip")
            await skipConversationCheckpointHandoff({
              address,
              operationId: started.operation.id,
            });
          else
            await cancelConversationCheckpoint({
              address,
              operationId: started.operation.id,
            });
          break;
        }
        if (
          operation?.handoff?.stage !== "pending" &&
          operation?.handoff?.stage !== "running"
        )
          break;
        await delay(10);
      }
    }
    await started.completion;
    const operation = await repo.getOperation(key, started.operation.id);
    const handoff = operation?.handoff;
    result.phase = operation?.phase ?? null;
    result.modeEstablished = handoff?.modeEstablished ?? null;
    result.captureSubmitted = handoff?.submitted ?? null;
    result.executionSettled = handoff?.executionSettled ?? null;
    result.omissionReason = handoff?.omissionReason ?? null;
    result.usage = handoff?.usage ?? null;
    result.activity = handoff?.activity ?? null;
    result.canaryAbsent = !existsSync(canary);
    result.seedSha256 =
      (await repo.getPayload(key, started.operation.id))?.seedSha256 ?? null;
    const expectedReason =
      scenario === "skip"
        ? "skipped"
        : scenario === "cancel"
          ? "cancelled"
          : scenario === "output-limit" ||
              scenario === "output-limit-injected" ||
              scenario === "output-limit-challenge"
            ? "output_limit"
            : scenario === "tool-violation"
              ? "prohibited_activity"
              : scenario === "execution-limit"
                ? "execution_limit"
                : null;
    const expectedPhase = scenario === "cancel" ? "cancelled" : "ready";
    const faultObservation = fault?.evidence();
    const captureReturn = faultObservation?.captures[0];
    const injectedBoundaryObserved =
      scenario === "tool-violation"
        ? options.codexFault?.evidence().fault === "tool-violation" &&
          options.codexFault.evidence().inputChallenge !== null &&
          handoff?.activity?.prohibited === "observed"
        : scenario === "output-limit-challenge"
          ? options.codexFault?.evidence().fault === "output-limit-challenge" &&
            options.codexFault.evidence().inputChallenge !== null
          : scenario === "setup-control-rejection"
            ? faultObservation?.captures.length === 1 &&
              captureReturn?.submitted === false &&
              captureReturn.modeEstablished === false &&
              captureReturn.sourceCloseCountAtReturn === 0 &&
              captureReturn.sourceExitObservedAtReturn === false &&
              faultObservation.events.some(
                (event) =>
                  event.event ===
                  "injected-suppression-rejection-before-dispatch",
              )
            : scenario === "provider-interruption" && backend === "codex"
              ? options.codexFault?.evidence().interruptSent === true &&
                options.codexFault.evidence().captureTurnStartAcknowledged ===
                  1 &&
                handoff?.stage === "omitted"
              : scenario === "execution-limit" && backend === "codex"
                ? options.codexFault?.evidence().executionSuspended === true &&
                  options.codexFault.evidence().executionLimitMs ===
                    CHECKPOINT_CAPTURE_LIMITS.executionMs
                : scenario === "provider-interruption"
                  ? faultObservation?.captures.length === 1 &&
                    faultObservation.interruptSent &&
                    captureReturn?.submitted === true &&
                    handoff?.stage === "omitted"
                  : scenario === "execution-limit" && backend === "claude"
                    ? faultObservation?.captures.length === 1 &&
                      faultObservation.executionSuspended &&
                      (faultObservation.resumeSent ||
                        faultObservation.processes.some(
                          (child) =>
                            child.kind === "capture" && child.sdkExitObserved,
                        )) &&
                      captureReturn?.submitted === true
                    : scenario === "output-limit-injected"
                      ? faultObservation?.captures.length === 1 &&
                        captureReturn?.submitted === true &&
                        faultObservation.terminalOverflow
                          ?.forwardedResultBytes ===
                          CHECKPOINT_CAPTURE_LIMITS.outputBytes + 1 &&
                        faultObservation.terminalOverflow
                          .providerAuthoredOversize === false
                      : true;
    if (!result.canaryAbsent) {
      result.status = "failed";
      result.reason = "capture executed the pending file action";
    } else if (!injectedBoundaryObserved) {
      result.reason =
        "requested real SDK fault boundary was not observed; no substitute outcome is certified";
    } else if (
      !handoff ||
      (scenario !== "setup-control-rejection" && !handoff.submitted) ||
      !handoff.executionSettled
    ) {
      result.reason =
        "actual capture submission and settled execution were not both observed";
    } else if (
      operation?.phase !== expectedPhase ||
      (expectedReason !== null && handoff.omissionReason !== expectedReason)
    ) {
      result.reason = `requested condition not observed: expected ${expectedPhase}/${expectedReason ?? "normal capture"}; observed ${operation?.phase}/${handoff.omissionReason}`;
    } else if (
      scenario === "pending-action" &&
      (!handoff.modeEstablished || handoff.stage !== "included")
    ) {
      result.reason =
        "normal included capture with established mode was not observed";
    } else {
      result.continued = await ordinary(
        "Answer with CONTINUED, without tools. Keep the pending file action deferred.",
      );
      result.followingRefDigest = await readBackendDigest();
      result.canaryAbsent = !existsSync(canary);
      result.status =
        result.continued && result.canaryAbsent ? "passed" : "failed";
      result.reason =
        result.status === "passed"
          ? scenario === "output-limit-injected"
            ? "explicitly fault-injected raw terminal overflow rejected; original provider success preserved privately; baseline continuation completed; not provider-authored oversized output"
            : "durable capture outcome and subsequent ordinary completion observed; pending file stayed absent"
          : "subsequent ordinary continuation did not complete";
    }
    return result;
  } catch (error) {
    result.reason = `probe stopped with ${error instanceof Error ? error.name : "unknown error"}; no unobserved outcome is certified`;
    return result;
  } finally {
    try {
      await stopConversationActor(
        environment.projectPath,
        sessionName ?? "__project__",
        conversationId,
        "handoff failure probe cleanup",
      );
      result.cleanupSettled = true;
    } catch {
      result.cleanupSettled = false;
      result.status = "incomplete";
      result.reason += "; actor cleanup did not settle";
    }
    if (fault) {
      const collected = await fault.restoreAndCollect();
      result.faultEvidence = fault.evidence();
      if (!collected) {
        result.cleanupSettled = false;
        result.status = "incomplete";
        result.reason += "; owned SDK child collection was not observed";
      }
    }
    if (options.codexFault) {
      const collected = await options.codexFault.restoreAndCollect();
      result.codexFaultEvidence = options.codexFault.evidence();
      if (!collected) {
        result.cleanupSettled = false;
        result.status = "incomplete";
        result.reason += "; actual app-server collection was not verified";
      }
    }
    if (existsSync(transcriptPath))
      result.transcriptSha256 = createHash("sha256")
        .update(readFileSync(transcriptPath))
        .digest("hex");
    result.elapsedMs = Date.now() - start;
  }
}

export async function runHandoffFailures(options: FailureProbeOptions) {
  assertIsolated(getStateDb().name, options.environment);
  const rows: FailureCaseEvidence[] = [];
  let haltedReason: string | null = null;
  for (const scenario of options.cases ??
    FAILURE_SCENARIOS.filter(
      (item) =>
        ![
          "output-limit-injected",
          "tool-violation",
          "output-limit-challenge",
        ].includes(item),
    )) {
    if (haltedReason) {
      rows.push(emptyEvidence(scenario, haltedReason));
      continue;
    }
    if (
      scenario === "daemon-restart" ||
      (options.backend !== "claude" &&
        (scenario === "setup-control-rejection" ||
          scenario === "output-limit-injected" ||
          (scenario === "provider-interruption" && !options.codexFault)))
    ) {
      const reason = {
        "setup-control-rejection":
          "requires an owned real Query control-rejection fixture; none was installed; no source Query was altered",
        "provider-interruption":
          "requires an observed owned provider child PID; no process was killed by name or inferred ownership",
        "output-limit-injected":
          "explicit terminal overflow injection is available only for the real Claude SDK fixture",
        "daemon-restart":
          "requires separate probe-process termination/restart and explicit test-operator stopped-execution testimony; not exercised by this in-process run",
      }[scenario];
      rows.push(emptyEvidence(scenario, reason));
      continue;
    }
    if (
      options.ledger.remaining("ordinary") < 2 ||
      options.ledger.remaining("compaction") < 2
    ) {
      rows.push(
        emptyEvidence(
          scenario,
          "submission cap prevents starting this case with its continuation and generation budget",
        ),
      );
      continue;
    }
    const row = await runCase(options, scenario);
    rows.push(row);
    if (row.cleanupSettled === false)
      haltedReason =
        "a previous scenario retained unsettled execution; no further provider calls were made";
  }
  return {
    status: rows.some((row) => row.status === "failed")
      ? ("failed" as const)
      : rows.length > 0 && rows.every((row) => row.status === "passed")
        ? ("passed" as const)
        : ("incomplete" as const),
    rows,
    limits: CHECKPOINT_CAPTURE_LIMITS,
  };
}
