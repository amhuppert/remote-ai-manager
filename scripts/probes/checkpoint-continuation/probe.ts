/**
 * The checkpoint continuation probe.
 *
 * Drives the production conversation manager and the real provider adapter
 * against an isolated scratch datastore and worktree: three checkpoint cycles
 * over one conversation, one of them delivered from the message queue, with
 * the continuity corpus as the source and its independently authored
 * expectations as the oracle.
 *
 * Everything the probe reports is read back from durable state — the
 * conversation row a restarted store would load, the checkpoint operation,
 * the archive on disk, and the structured log this run wrote — rather than
 * from anything the probe itself remembers. A model answer only ever counts
 * as evidence about retrieval quality; the continuity claims are settled by
 * references, hashes and receipts.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationAddress } from "@/lib/workflows/conversation/turn-spec";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import {
  CORPUS_PNG_BASE64,
  assembleContinuityTranscript,
  expectationsForCycle,
  gradeContinuityAnswer,
  type AssembledExpectation,
} from "@/lib/conversation-checkpoints/fixtures/continuity-corpus";
import { getConversationCheckpointsRepo } from "@/lib/conversation-checkpoints/service-factory";
import { checkpointScopeKeyForStoreIdentity } from "@/lib/workflows/conversation/actor-input-loader";
import { getCompactionService } from "@/lib/context-artifacts/route-handlers";
import { createHistoryImageService } from "@/lib/conversations/history-image-service";
import type { ImagePayload } from "@/lib/images/schemas";
import { getMemoryService } from "@/lib/memory/service-factory";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { queueMessage } from "@/lib/prompt/queue";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import {
  createProjectConversationRecord,
  createSessionRow,
  getConversation,
  getSession,
  getProjectConversation,
  getStateDb,
} from "@/lib/state-store";
import {
  ensureConversationActorAndDrain,
  startConversationCheckpoint,
  stopConversationActor,
  submitConversationTurn,
} from "@/lib/workflows/conversation/manager";

import { createProbeCallLedger, type ProbeCallLedger } from "./budget";
import { instrumentTaskRunnersForProbe } from "./instrumentation";
import { enableCheckpointCapabilityForProbe } from "./capability";
import { assertIsolated, type ProbeEnvironment } from "./environment";
import {
  checkpointRuntimeCreations,
  countEvents,
  promptCompletionCosts,
  readRunLog,
} from "./run-log";
import type {
  ProbeAnswerEvidence,
  ProbeCycleEvidence,
  ProbeRunEvidence,
} from "./evidence";

/** The store session name a project conversation is filed under. */
const PROJECT_SENTINEL = "__project__";

const MEMORY_PROBE_SLUG = "probe-continuity-memory-witness";
const MEMORY_PROBE_HOOK =
  "The checkpoint continuation probe's memory witness note is addressed as probe-continuity-memory-witness.";

/**
 * Appended to every question so one call answers both what the conversation
 * remembers and whether the fresh runtime was handed its ordinary memory
 * index. Two separate turns would double the probe's ordinary-call spend to
 * learn one extra bit.
 */
const NO_TOOLS_PREFIX =
  "Answer from this conversation's context alone. Do not use any tools, do not read any files, and do not start any background work.\n\n";

const MEMORY_WITNESS_SUFFIX = [
  "",
  "Then, on its own final line, print MEMORY-WITNESS: followed by the slug of any memory note listed in this turn's context, or MEMORY-WITNESS: none if no memory index is present.",
].join("\n");

const CONTROL_PROMPT = `${NO_TOOLS_PREFIX}Reply with the single word CONTINUED.${MEMORY_WITNESS_SUFFIX}`;

/** The exact ordinary message a probe question is delivered as. */
/**
 * `withImage` names the attachment for a fact that lives in pixels: the
 * no-tools framing otherwise reads as an instruction to ignore anything that
 * is not text.
 */
/**
 * A question that may be delivered in the same turn as its siblings.
 *
 * The queue holds several messages and the runtime delivers them as one turn,
 * so the questions arrive concatenated. Several corpus questions legitimately
 * end in "answer with just the number and nothing else" — sound in isolation,
 * but read together the last such instruction tells the model to suppress the
 * answers to every earlier question. That is an instruction-following artifact
 * of the batching, not a continuity result, and it has to be removed from the
 * measurement rather than absorbed by whichever model happens to ignore it.
 */
function queuedQuestionPrompt(expectation: AssembledExpectation): string {
  return [
    "Answer EVERY question in this message from this conversation's context alone. Do not use any tools, do not read any files, and do not start any background work.",
    "",
    "Where a question says to answer with nothing else, that applies to that question's own answer line, not to the message.",
    "",
    `Question [${expectation.id}]: ${expectation.question}`,
    "",
    `Reply on its own line as "${expectation.id}: <answer>".`,
    MEMORY_WITNESS_SUFFIX.trim(),
  ].join("\n");
}

function questionPrompt(question: string, withImage = false): string {
  const framing = withImage
    ? `${NO_TOOLS_PREFIX}The image attached to this message is the original chart from earlier in this conversation, re-attached for you.\n\n`
    : NO_TOOLS_PREFIX;
  return `${framing}${question}${MEMORY_WITNESS_SUFFIX}`;
}

export interface ProbeRunOptions {
  backend: AgentBackendId;
  scope: "session" | "project";
  environment: ProbeEnvironment;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Raw JSONL lines exactly as they sit on disk. */
function archiveLines(transcriptPath: string): string[] {
  return readFileSync(transcriptPath, "utf-8").split("\n");
}

function completedText(outcome: unknown): string {
  const call = outcome as {
    kind?: string;
    result?: { outcome?: { kind?: string; text?: string } };
  };
  if (call.kind !== "call_result") {
    throw new Error(`turn did not reach the provider: ${JSON.stringify(call)}`);
  }
  const inner = call.result?.outcome;
  if (inner?.kind !== "completed" || typeof inner.text !== "string") {
    throw new Error(`turn failed: ${JSON.stringify(inner)}`);
  }
  return inner.text;
}

function turnCostUsd(outcome: unknown): number | null {
  const usage = (
    outcome as { result?: { usage?: { costUsd?: number | null } } }
  ).result?.usage;
  return typeof usage?.costUsd === "number" ? usage.costUsd : null;
}

function memoryWitness(answer: string): string | null {
  const match = /MEMORY-WITNESS:\s*(\S+)/i.exec(answer);
  return match?.[1] ?? null;
}

export async function runCheckpointContinuationProbe(
  options: ProbeRunOptions,
): Promise<ProbeRunEvidence> {
  const { backend, scope, environment } = options;
  const startedAt = new Date().toISOString();
  const ledger = createProbeCallLedger();
  const failures: string[] = [];
  const record = (condition: boolean, message: string): void => {
    if (!condition) failures.push(message);
  };

  assertIsolated(getStateDb().name, environment);
  // Before anything can reach a provider: every compaction call this run
  // causes is made inside production code, so the ceiling is enforced at the
  // task runner rather than reconciled from a receipt afterwards.
  instrumentTaskRunnersForProbe(ledger);
  const capability = enableCheckpointCapabilityForProbe(backend);

  // ---- seed the isolated conversation and its original archive -----------
  const conversationId = randomUUID();
  const { getTranscriptPath } = await import("@/lib/prompt/transcript");
  const transcriptPath = await getTranscriptPath(conversationId);
  const assembled = assembleContinuityTranscript({
    imageRefPath: environment.imageRefPath,
  });
  writeFileSync(
    transcriptPath,
    `${assembled.lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf-8",
  );

  const conversation: ConversationState = makeConversationState({
    id: conversationId,
    agentBackend: backend,
    transcriptPath,
    status: "awaiting",
    promptCount: assembled.lines.filter((line) => line.role === "user").length,
    createdAt: startedAt,
    lastActivityAt: startedAt,
  });
  const sessionName = scope === "session" ? "checkpoint-probe" : null;
  if (sessionName !== null) {
    await createSessionRow(
      environment.projectPath,
      sessionStateSchema.parse({
        sessionName,
        worktreePath: environment.projectPath,
        branchName: "main",
        createdAt: startedAt,
        lastActivityAt: startedAt,
        conversations: [conversation],
      }),
    );
  } else {
    await createProjectConversationRecord(
      environment.projectPath,
      conversation,
    );
  }

  const memoryNote = await getMemoryService().create(
    {
      scope: "global",
      // Global scope admits no `state` note; the witness is a lesson.
      kind: "lesson",
      hook: MEMORY_PROBE_HOOK,
      slug: MEMORY_PROBE_SLUG,
      // Reserved a slot, so the witness is in the index whatever the turn is about.
      indexMode: "always",
    },
    { kind: "user", visibility: { projectPath: null, session: null } },
  );
  if (!memoryNote.ok) {
    throw new Error(
      `the memory witness note was refused: ${JSON.stringify(memoryNote.error)}`,
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
  const storeSessionName = sessionName ?? PROJECT_SENTINEL;
  const scopeKey = checkpointScopeKeyForStoreIdentity({
    projectPath: environment.projectPath,
    sessionName: storeSessionName,
    conversationId,
  });
  const checkpoints = getConversationCheckpointsRepo();

  const readRow = async (): Promise<ConversationState> => {
    const row =
      sessionName === null
        ? await getProjectConversation(environment.projectPath, conversationId)
        : await getConversation(
            environment.projectPath,
            sessionName,
            conversationId,
          );
    if (!row) throw new Error("the probe conversation row disappeared");
    return row;
  };

  const originalLines = archiveLines(transcriptPath).filter(
    (line) => line.length > 0,
  );
  const originalLineHashes = originalLines.map((line) => sha256(line));
  const imageBytesSha = sha256(Buffer.from(CORPUS_PNG_BASE64, "base64"));

  // ---- ordinary and queued turn helpers ---------------------------------
  async function runOrdinaryTurn(
    promptText: string,
    label: string,
    images: readonly ImagePayload[] = [],
  ): Promise<{ answer: string; attemptId: string }> {
    const token = ledger.admit("ordinary", label, backend);
    const admission = await submitConversationTurn({
      binding: { kind: "durable", address },
      turn: { promptText, images: [...images] },
    });
    if (admission.kind !== "accepted") {
      throw new Error(
        `turn "${label}" was not admitted: ${JSON.stringify(admission)}`,
      );
    }
    const settled = await admission.turn.completed;
    ledger.settle(token, { costUsd: turnCostUsd(settled.outcome) });
    return {
      answer: completedText(settled.outcome),
      attemptId: settled.attemptId,
    };
  }

  /**
   * The original image, recovered after checkpointing through the production
   * scoped reader, addressed by its archive handle.
   *
   * An image-backed expectation names a number that exists only in these
   * pixels. The seed cannot carry the image — it is a text budget — so the
   * bounded recovery is this: read the bytes back out of the archive by
   * conversation id, original raw sequence and content-block index, verify
   * they are byte-identical to what was recorded before any checkpoint, and
   * hand them to the asking turn. A checkpoint that damaged or replaced the
   * archive's image fails here rather than being graded on a lucky guess.
   */
  async function recoverExpectationImage(
    expectation: AssembledExpectation,
  ): Promise<readonly ImagePayload[]> {
    const seq = expectation.sourceSeqs[0];
    if (seq === undefined) {
      record(false, `${expectation.id}: no source sequence to recover from`);
      return [];
    }
    const recovered = await createHistoryImageService().getImage({
      conversationId,
      seq,
      contentBlockIndex: 0,
      transcriptPath,
    });
    if (!recovered.ok) {
      record(
        false,
        `${expectation.id}: the original image did not survive checkpointing (${recovered.code})`,
      );
      return [];
    }
    record(
      recovered.image.sha256 === imageBytesSha,
      `${expectation.id}: the recovered image is not the original bytes`,
    );
    return [
      {
        attachmentId: randomUUID(),
        mediaType: "image/png",
        base64Data: recovered.image.bytes.toString("base64"),
      },
    ];
  }

  /** Enqueue without draining, so the queue is what the checkpoint holds. */
  async function enqueue(promptText: string): Promise<string> {
    const queued = await queueMessage({
      projectPath: environment.projectPath,
      sessionName: storeSessionName,
      conversationId,
      text: promptText,
      backend,
    });
    return queued.entry.id;
  }

  /** The text of a queue entry, joined the way it was enqueued. */
  function queueEntryText(entry: {
    content: readonly { type: string; text?: string }[];
  }): string {
    return entry.content
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("");
  }

  function assistantTexts(): string[] {
    return archiveLines(transcriptPath)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TranscriptEntry)
      .filter((entry) => entry.role === "assistant")
      .map((entry) =>
        (entry.content ?? [])
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("\n"),
      );
  }

  /** Drain the queue and wait for the delivered turn to settle. */
  async function drainQueuedTurn(label: string): Promise<string> {
    const token = ledger.admit("ordinary", label, backend);
    const before = assistantTexts().length;
    const completionsBefore = promptCompletionCosts(
      readRunLog(environment.configDir),
    ).length;
    await ensureConversationActorAndDrain(
      environment.projectPath,
      storeSessionName,
      conversationId,
    );
    const deadline = Date.now() + 10 * 60_000;
    for (;;) {
      const row = await readRow();
      const drained =
        row.status !== "running" &&
        row.pendingQueue.every(
          (entry) =>
            entry.status !== "pending" && entry.status !== "delivering",
        );
      if (drained && assistantTexts().length > before) break;
      if (Date.now() > deadline) {
        throw new Error(`queued turn "${label}" never settled`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    // A drained turn settles inside the actor rather than on a handle the
    // caller holds. The actor still records the turn's cost, so the delivery
    // is priced from the completion that appeared across this drain. More than
    // one means the positional correlation is not sound for this run, and the
    // cost stays unavailable rather than being attributed to the wrong turn.
    const delivered = promptCompletionCosts(
      readRunLog(environment.configDir),
    ).slice(completionsBefore);
    record(
      delivered.length === 1,
      `queued turn "${label}": ${delivered.length} ordinary completions settled across the drain, so its cost cannot be correlated`,
    );
    ledger.settle(token, {
      costUsd: delivered.length === 1 ? (delivered[0] ?? null) : null,
    });
    return assistantTexts().at(-1) ?? "";
  }

  // ---- one warm-up turn, so a live runtime exists to retire --------------
  // Runs before the reading artifact so the artifact's coverage is the same
  // boundary the first checkpoint captures.
  const warmup = await runOrdinaryTurn(
    `${NO_TOOLS_PREFIX}Reply with the single word ACKNOWLEDGED.${MEMORY_WITNESS_SUFFIX}`,
    "warm-up",
  );
  record(
    memoryWitness(warmup.answer) === MEMORY_PROBE_SLUG,
    `warm-up turn did not receive the ordinary memory index (reported ${memoryWitness(warmup.answer) ?? "nothing"})`,
  );
  const seededRef = (await readRow()).backendRef;
  record(
    seededRef !== null,
    "the warm-up turn established no provider reference to retire",
  );

  // ---- the reading artifact, generated before any checkpoint -------------
  // Two things at once: it proves artifact generation is independent of the
  // checkpoint lifecycle, and it leaves cycle 1 an envelope whose coverage and
  // source hash match, which is what keeps three cycles inside the six-call
  // compaction budget. Nothing may append to the archive between here and the
  // first checkpoint, or the coverage no longer matches and the fold repeats.
  const refBeforeArtifact = (await readRow()).backendRef?.ref ?? null;
  const artifact = await getCompactionService().trigger({
    kind: "conversation_compaction",
    scope: sessionName === null ? "project" : "session",
    projectPath: environment.projectPath,
    projectName: environment.projectName,
    sessionName,
    conversationId,
    transcriptPath,
    createdBy: "user",
    trigger: "checkpoint_probe",
  });
  if (artifact.outcome !== "started") {
    throw new Error(
      `reading artifact was not generated: ${JSON.stringify(artifact)}`,
    );
  }
  const artifactRow = await artifact.completion;
  record(
    artifactRow.status === "complete",
    `reading artifact did not complete (status ${artifactRow.status})`,
  );
  const afterArtifact = await readRow();
  record(
    (await checkpoints.listReceipts(scopeKey, { limit: 5 })).receipts.length ===
      0,
    "generating a reading artifact created a checkpoint operation",
  );
  record(
    (afterArtifact.backendRef?.ref ?? null) === refBeforeArtifact,
    "generating a reading artifact retired the conversation's provider reference",
  );

  const identityBefore = await readRow();
  const cycles: ProbeCycleEvidence[] = [];

  async function runCycle(input: {
    cycle: 1 | 2 | 3;
    queued: boolean;
  }): Promise<ProbeCycleEvidence> {
    const { cycle, queued } = input;
    const priorRow = await readRow();
    const priorRef = priorRow.backendRef?.ref ?? null;
    const logBefore = readRunLog(environment.configDir).length;

    const expectations = expectationsForCycle(assembled, cycle);
    const queuedMessageIds: string[] = [];

    const started = await startConversationCheckpoint({
      address,
      requestId: randomUUID(),
    });
    if (started.kind === "refused") {
      throw new Error(
        `cycle ${cycle} checkpoint refused: ${started.refusal.code} — ${started.refusal.reason}`,
      );
    }
    const ready = await started.completion;
    if (ready.phase !== "ready") {
      throw new Error(
        `cycle ${cycle} checkpoint ended ${ready.phase}: ${JSON.stringify(ready.failure)}`,
      );
    }
    const receipt = await checkpoints.getReceipt(scopeKey, ready.id);
    const payload = await checkpoints.getPayload(scopeKey, ready.id);
    if (!receipt || !payload) {
      throw new Error(`cycle ${cycle} produced no durable receipt or payload`);
    }
    const retired = await readRow();
    record(
      retired.backendRef === null,
      `cycle ${cycle}: readiness left a provider reference on the conversation row`,
    );
    const seedBytes = Buffer.byteLength(payload.seedText, "utf-8");
    record(
      seedBytes <= 32_768,
      `cycle ${cycle}: the injected checkpoint is ${seedBytes} bytes, over the 32768-byte budget`,
    );
    record(
      payload.seedSha256 === sha256(Buffer.from(payload.seedText, "utf-8")),
      `cycle ${cycle}: the frozen seed hash does not match its bytes`,
    );

    // ---- delivery -------------------------------------------------------
    // The queued cycle's whole batch arrives as one turn; otherwise the first
    // expectation is the delivery turn and each remaining one is a following
    // turn, which is also the observation that no second seed was injected.
    const answers: ProbeAnswerEvidence[] = [];
    const witnesses: (string | null)[] = [];
    const first = expectations[0];
    if (!first) throw new Error(`cycle ${cycle} has no expectation to ask`);
    let firstAnswer: string;
    // A queued batch is delivered as plain text, so an image-backed fact must
    // never be graded there: it would be marked wrong for a missing image
    // rather than for lost continuity.
    record(
      !queued || expectations.every((item) => item.evidence !== "image"),
      `cycle ${cycle}: an image-backed expectation was scheduled on the queued cycle, where its image cannot be supplied`,
    );
    if (queued) {
      // Enqueued only once the checkpoint is ready. An enqueue during the
      // build bumps the conversation's activity epoch, and the build fence
      // correctly refuses a retirement whose source moved underneath it.
      const enqueuedTexts: string[] = [];
      for (const expectation of expectations) {
        const text = queuedQuestionPrompt(expectation);
        enqueuedTexts.push(text);
        queuedMessageIds.push(await enqueue(text));
      }
      // Read back before the drain consumes them: the entries a retired
      // conversation holds are the same ids, in enqueue order, still carrying
      // the bytes that were enqueued.
      const heldQueue = (await readRow()).pendingQueue;
      record(
        JSON.stringify(heldQueue.map((entry) => entry.id)) ===
          JSON.stringify(queuedMessageIds),
        `cycle ${cycle}: the retired conversation did not hold its queued entries in enqueue order`,
      );
      record(
        JSON.stringify(heldQueue.map(queueEntryText)) ===
          JSON.stringify(enqueuedTexts),
        `cycle ${cycle}: a queued message's content changed while the conversation was retired`,
      );
      firstAnswer = await drainQueuedTurn(`cycle ${cycle} queued delivery`);
      for (const expectation of expectations) {
        answers.push(grade(expectation, firstAnswer));
      }
      // Delivery consumes the queue rather than leaving entries behind, so a
      // lost or duplicated message shows up as a survivor here.
      record(
        (await readRow()).pendingQueue.length === 0,
        `cycle ${cycle}: the queue still held entries after the delivered turn`,
      );
    } else {
      firstAnswer = (
        await runOrdinaryTurn(
          questionPrompt(first.question, first.evidence === "image"),
          `cycle ${cycle} delivery`,
          first.evidence === "image"
            ? await recoverExpectationImage(first)
            : [],
        )
      ).answer;
      answers.push(grade(first, firstAnswer));
    }
    witnesses.push(memoryWitness(firstAnswer));

    const applied = await checkpoints.getOperation(scopeKey, ready.id);
    if (!applied) throw new Error(`cycle ${cycle} operation vanished`);
    const acceptedRef = applied.protectedReferences.acceptedBackendRef;
    record(
      applied.phase === "applied",
      `cycle ${cycle}: the checkpoint is ${applied.phase}, not applied, after the first ordinary message`,
    );
    record(
      applied.acceptance?.seedHash === payload.seedSha256,
      `cycle ${cycle}: acceptance did not record the frozen seed's hash`,
    );
    record(
      acceptedRef !== null && acceptedRef !== priorRef,
      `cycle ${cycle}: the continued conversation did not move to a new provider reference`,
    );
    record(
      applied.protectedReferences.priorBackendRef === priorRef,
      `cycle ${cycle}: the retired reference was not recorded`,
    );
    if (queued) {
      record(
        queuedMessageIds.includes(applied.delivery?.queuedMessageId ?? ""),
        `cycle ${cycle}: the queued delivery was not correlated to an enqueued message`,
      );
    }

    // The archive stores the user's actual message, never the seed.
    const archived = archiveLines(transcriptPath)
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as TranscriptEntry)
      .filter((entry) => entry.role === "user");
    const newestUserText = (archived.at(-1)?.content ?? [])
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    record(
      !newestUserText.includes("## Checkpoint context"),
      `cycle ${cycle}: the archive stored the injected checkpoint instead of the user's message`,
    );

    // ---- the turns after delivery: continuity resumes, no second seed --
    const following = queued ? [] : expectations.slice(1);
    for (const expectation of following) {
      const answer = (
        await runOrdinaryTurn(
          questionPrompt(
            expectation.question,
            expectation.evidence === "image",
          ),
          `cycle ${cycle} follow-up ${expectation.id}`,
          expectation.evidence === "image"
            ? await recoverExpectationImage(expectation)
            : [],
        )
      ).answer;
      answers.push(grade(expectation, answer));
      witnesses.push(memoryWitness(answer));
    }
    if (following.length === 0) {
      const control = await runOrdinaryTurn(
        CONTROL_PROMPT,
        `cycle ${cycle} follow-up`,
      );
      witnesses.push(memoryWitness(control.answer));
    }
    const afterControl = await readRow();
    record(
      afterControl.backendRef?.ref === acceptedRef,
      `cycle ${cycle}: the turn after delivery did not resume the accepted continuation`,
    );
    const cycleLog = readRunLog(environment.configDir).slice(logBefore);
    const freshRuntimeEvents = countEvents(
      cycleLog,
      "checkpoint.fresh_runtime",
      ready.id,
    );
    record(
      freshRuntimeEvents === 1,
      `cycle ${cycle}: expected exactly one fresh-runtime start for this checkpoint, saw ${freshRuntimeEvents}`,
    );
    // R9.4's "no old-session resume/fork", read off what the runtime factory
    // was handed rather than inferred from the reference changing.
    const freshRuntimeResumeRefs = checkpointRuntimeCreations(
      cycleLog,
      ready.id,
    ).map((creation) => creation.hasResumeRef);
    record(
      freshRuntimeResumeRefs.length > 0 &&
        freshRuntimeResumeRefs.every((hasResumeRef) => hasResumeRef === false),
      `cycle ${cycle}: the runtime receiving the checkpoint was created with a resume handle (${freshRuntimeResumeRefs.map((value) => String(value)).join(", ") || "no creation recorded"})`,
    );
    const acceptedEvents = countEvents(
      cycleLog,
      "checkpoint.delivery.accepted",
      ready.id,
    );
    record(
      acceptedEvents === 1,
      `cycle ${cycle}: the frozen seed was accepted ${acceptedEvents} times, not once`,
    );
    const resumeRefMissingEvents = countEvents(
      cycleLog,
      "prompt.resume_ref_missing",
    );
    record(
      resumeRefMissingEvents === 0,
      `cycle ${cycle}: a turn reported a missing resume handle`,
    );
    record(
      witnesses.every((witness) => witness === MEMORY_PROBE_SLUG),
      `cycle ${cycle}: a turn did not receive the ordinary memory index (reported ${witnesses.map((witness) => witness ?? "nothing").join(", ")})`,
    );
    record(
      cycle !== 1 ||
        countEvents(cycleLog, "checkpoint.source.envelope_reused", ready.id) ===
          1,
      "cycle 1 refolded the conversation instead of reusing the matching reading envelope",
    );

    // Identity and archive are untouched by any of it.
    record(
      afterControl.id === identityBefore.id &&
        afterControl.transcriptPath === identityBefore.transcriptPath &&
        afterControl.agentBackend === identityBefore.agentBackend,
      `cycle ${cycle}: the CC conversation identity changed`,
    );
    record(
      JSON.stringify(afterControl.forkedFrom ?? null) ===
        JSON.stringify(identityBefore.forkedFrom ?? null),
      `cycle ${cycle}: fork provenance changed`,
    );
    if (sessionName !== null) {
      const session = await getSession(environment.projectPath, sessionName);
      record(
        session?.worktreePath === environment.projectPath,
        `cycle ${cycle}: the session's worktree moved (${session?.worktreePath ?? "session missing"})`,
      );
    }
    const nowLines = archiveLines(transcriptPath).filter(
      (line) => line.length > 0,
    );
    record(
      originalLineHashes.every(
        (hash, index) => sha256(nowLines[index] ?? "") === hash,
      ),
      `cycle ${cycle}: the original transcript lines were rewritten`,
    );

    return {
      cycle,
      operationId: ready.id,
      ordinal: receipt.ordinal,
      phase: applied.phase,
      seedSha256: payload.seedSha256,
      seedBytes,
      generationPassCount: receipt.generationPassCount,
      compactionCostUsd: receipt.compactionUsage.costUsd,
      priorBackendRef: priorRef,
      acceptedBackendRef: acceptedRef,
      queuedMessageIds,
      queuedAttemptId: applied.delivery?.queuedAttemptId ?? null,
      freshRuntimeEvents,
      freshRuntimeResumeRefs,
      acceptedEvents,
      resumeRefMissingEvents,
      seedReinjectedAfterDelivery: freshRuntimeEvents > 1,
      answers,
    };
  }

  function grade(
    expectation: AssembledExpectation,
    answer: string,
  ): ProbeAnswerEvidence {
    const graded = gradeContinuityAnswer(answer, expectation);
    return {
      expectationId: expectation.id,
      kind: expectation.kind,
      question: expectation.question,
      answer,
      satisfied: graded.satisfied,
      missing: graded.missing,
      forbidden: graded.forbidden,
    };
  }

  for (const cycle of [1, 2, 3] as const) {
    cycles.push(await runCycle({ cycle, queued: cycle === 2 }));
  }

  // ---- closing checks over the whole run --------------------------------
  const finalLines = archiveLines(transcriptPath).filter(
    (line) => line.length > 0,
  );
  record(
    finalLines.length > originalLines.length,
    "the archive did not grow across the run",
  );
  record(
    sha256(readFileSync(environment.imageRefPath)) === imageBytesSha,
    "the externally referenced image bytes changed",
  );
  record(
    finalLines.some((line) => line.includes(CORPUS_PNG_BASE64)),
    "the inline image bytes are no longer in the archive",
  );
  const refs = cycles.map((cycle) => cycle.acceptedBackendRef);
  record(
    new Set(refs.filter((ref) => ref !== null)).size === refs.length,
    "two cycles reported the same provider reference",
  );

  await stopConversationActor(
    environment.projectPath,
    storeSessionName,
    conversationId,
    "checkpoint probe finished",
  );

  return {
    runId: environment.runId,
    backend,
    scope,
    startedAt,
    finishedAt: new Date().toISOString(),
    configDir: environment.configDir,
    conversationId,
    worktreePath: environment.projectPath,
    transcriptPath,
    descriptorCheckpointCapability: capability,
    modelSelection: environment.modelSelection,
    cycles,
    callTotals: ledger.totals(),
    calls: ledger.calls(),
    outcome: failures.length === 0 ? "passed" : "failed",
    failures,
  };
}

export type { ProbeCallLedger };
