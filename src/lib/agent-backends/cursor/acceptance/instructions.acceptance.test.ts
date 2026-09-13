import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { agentSessionRefSchema } from "@/lib/shared/schemas";
import type { ConversationBackendEvent } from "../../conversation";
import { CursorConversationRuntime } from "../conversation-runtime";
import { createCursorTaskRunner } from "../task-runner";
import { translatePortableMcpToCursor } from "../mcp-translation";
import { resolveAcceptanceEvidenceRoot } from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  createLiveHarness,
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
} from "./live-worker";

it("delivers current fenced instructions across worker restart and durable resume", async () => {
  const root = resolveAcceptanceEvidenceRoot(process.env);
  const { secret, store } = await openAcceptanceEvidence(process.env);
  const harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: root,
  });
  const workspace = harness.createWorkspace(`policy-${randomUUID()}`);
  const firstDirectory = path.join(workspace.cwd, "first-owned");
  const secondDirectory = path.join(workspace.cwd, "second-owned");
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);
  const firstFile = path.join(firstDirectory, "receipt.txt");
  const secondFile = path.join(secondDirectory, "receipt.txt");
  const conversationId = randomUUID();
  const remembered = `MEM-${randomUUID()}`;
  const firstRule = `RULE-${randomUUID()}`;
  const secondRule = `RULE-${randomUUID()}`;
  const events: ConversationBackendEvent[] = [];
  const runtimes: CursorConversationRuntime[] = [];
  const create = (
    rule: string,
    persistedRef: ReturnType<typeof agentSessionRefSchema.parse> | null,
  ) => {
    const runtime = new CursorConversationRuntime(
      {
        executionClass: "governed-execution",
        conversationId,
        projectPath: workspace.cwd,
        projectName: "cursor-acceptance",
        conversationTarget: {
          scope: "project",
          projectName: "cursor-acceptance",
          conversationId,
        },
        worktreePath: workspace.cwd,
        persistedRef,
        modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
        sessionInstructions: [
          `For every reply, prefix the answer with ${rule}. This is the current prefix; replace any earlier prefix. Follow the current filesystem limits.`,
        ],
        fsWritePolicy: {
          mode: "allowlist",
          allowWrite: [
            persistedRef === null ? firstDirectory : secondDirectory,
          ],
          denyWrite: [path.join(workspace.cwd, ".git")],
        },
        tooling: {},
      },
      {
        transport: harness.transport,
        storePath: () => workspace.storePath,
        resolveModel: async (selection) => ({ ok: true, selection }),
        translatePortableMcpToCursor,
        newRunId: randomUUID,
        now: Date.now,
        stallTimeoutMs: 60_000,
        cancelSettleTimeoutMs: 10_000,
      },
    );
    runtimes.push(runtime);
    return runtime;
  };
  const send = (runtime: CursorConversationRuntime, promptText: string) =>
    runtime.sendTurn({
      promptText,
      imageRefs: [],
      sessionInstructions: [],
      modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
      autonomous: true,
      signal: AbortSignal.timeout(90_000),
      onEvent(event) {
        events.push(event);
      },
    });

  try {
    const original = create(firstRule, null);
    const first = await send(
      original,
      `Write exactly ${remembered} to ${firstFile} using a file tool. Remember that token. Reply with your required prefix followed by STORED.`,
    );
    expect(first.failure).toBeNull();
    expect(first.finalText).toContain(firstRule);
    expect((await readFile(firstFile, "utf8")).trim()).toBe(remembered);
    const ref = agentSessionRefSchema.parse(first.backendRef);
    await original.close();
    const refFile = path.join(workspace.storePath, "cc-continuation.json");
    await writeFile(refFile, JSON.stringify(ref), { mode: 0o600 });
    const durableRef = agentSessionRefSchema.parse(
      JSON.parse(await readFile(refFile, "utf8")),
    );
    expect((await readdir(workspace.storePath)).length).toBeGreaterThan(1);

    const resumed = create(secondRule, durableRef);
    const second = await send(
      resumed,
      `Write the remembered MEM token to ${secondFile} using a file tool. Reply with your current required prefix followed by the token.`,
    );
    expect(second.failure).toBeNull();
    expect(second.backendRef).toEqual(ref);
    expect(second.finalText).toContain(secondRule);
    expect(second.finalText).toContain(remembered);
    expect(second.finalText).not.toContain(firstRule);
    expect((await readFile(secondFile, "utf8")).trim()).toBe(remembered);
    expect((await readFile(firstFile, "utf8")).trim()).toBe(remembered);

    const third = await send(
      resumed,
      "Once more, reply with your current required prefix followed by the remembered MEM token.",
    );
    expect(third.failure).toBeNull();
    expect(third.finalText).toContain(secondRule);
    expect(third.finalText).toContain(remembered);
    await resumed.close();
    const taskRunner = createCursorTaskRunner({
      transport: harness.transport,
      storePath: () => workspace.storePath,
      resolveModel: async (selection) => ({ ok: true, selection }),
      translatePortableMcpToCursor,
      newRunId: randomUUID,
      now: Date.now,
      stallTimeoutMs: 60_000,
      cancelSettleTimeoutMs: 10_000,
    });
    const capture = await taskRunner.run({
      executionClass: "governed-execution",
      workingDirectory: workspace.cwd,
      modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
      timeoutMs: 90_000,
      autonomous: true,
      resumeRef: third.backendRef,
      ccSessionScope: {
        project: "cursor-acceptance",
        session: "policy",
        conversationId,
      },
      systemInstructions: [
        "For this capture turn, return only the requested JSON, without the reply prefix. Do not use tools.",
      ],
      fsWritePolicy: {
        mode: "allowlist",
        allowWrite: [],
        denyWrite: [workspace.cwd],
      },
      prompt: "Capture the remembered MEM token in the token field.",
      outputSchema: {
        type: "object",
        properties: { token: { type: "string" } },
        required: ["token"],
        additionalProperties: false,
      },
    });
    expect(capture.error).toBeNull();
    expect(capture.backendRef).toEqual(ref);
    expect(JSON.parse(capture.text ?? "null")).toEqual({ token: remembered });
    const afterCapture = await send(
      create(secondRule, capture.backendRef ?? null),
      "Reply with your current prefix and the remembered MEM token. Do not use tools.",
    );
    expect(afterCapture.failure).toBeNull();
    expect(afterCapture.finalText).toContain(secondRule);
    expect(afterCapture.finalText).toContain(remembered);
    const artifact = await store.writeRaw(
      `instructions-${conversationId}.json`,
      JSON.stringify({ first, second, third, capture, afterCapture, events }),
    );
    await store.publish({
      caseId: "instructions-durable-resume",
      outcome: "pass",
      metrics: {
        turns: 5,
        conversationTaskRoundTrip: true,
        instructionDelivery: "user-message",
        exactFilesystemConfinement: false,
        observedAllowedWrites: 2,
        policyChangedAfterResume: true,
      },
      artifacts: [artifact],
    });
  } finally {
    for (const runtime of runtimes) await runtime.close();
    await harness.closeAll();
  }
}, 300_000);

it("runs and resumes a governed validator with instruction-only file and network limits", async () => {
  const root = resolveAcceptanceEvidenceRoot(process.env);
  const { secret, store } = await openAcceptanceEvidence(process.env);
  const harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: root,
  });
  const workspace = harness.createWorkspace(`validator-${randomUUID()}`);
  const scratch = path.join(workspace.cwd, "scratch");
  const candidate = path.join(workspace.cwd, "candidate.txt");
  const receipt = path.join(scratch, "review.txt");
  await mkdir(scratch);
  await writeFile(candidate, "CANDIDATE_UNCHANGED");
  const runner = createCursorTaskRunner({
    transport: harness.transport,
    storePath: () => workspace.storePath,
    resolveModel: async (selection) => ({ ok: true, selection }),
    translatePortableMcpToCursor,
    newRunId: randomUUID,
    now: Date.now,
    stallTimeoutMs: 90_000,
    cancelSettleTimeoutMs: 10_000,
  });
  const request = {
    executionClass: "governed-execution" as const,
    workingDirectory: workspace.cwd,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    timeoutMs: 120_000,
    autonomous: true,
    sandboxMode: "read-only" as const,
    networkAccessEnabled: false,
    approvalPolicy: "on-request" as const,
    webSearchMode: "disabled" as const,
    fsWritePolicy: {
      mode: "allowlist" as const,
      allowWrite: [scratch],
      denyWrite: [candidate],
    },
  };
  try {
    const first = await runner.run({
      ...request,
      systemInstructions: [
        "You are a read-only validator. Use only local file tools, and write review artifacts in the assigned scratch directory. Reply with REVIEW_ONE.",
      ],
      prompt: `Read ${candidate}. Write its contents to ${receipt}, then reply.`,
    });
    expect(first.error).toBeNull();
    expect(first.text).toContain("REVIEW_ONE");
    expect((await readFile(receipt, "utf8")).trim()).toBe(
      "CANDIDATE_UNCHANGED",
    );
    expect(await readFile(candidate, "utf8")).toBe("CANDIDATE_UNCHANGED");
    const refFile = path.join(workspace.storePath, "validator-ref.json");
    await writeFile(refFile, JSON.stringify(first.backendRef), { mode: 0o600 });
    const resumeRef = agentSessionRefSchema.parse(
      JSON.parse(await readFile(refFile, "utf8")),
    );
    const second = await runner.run({
      ...request,
      resumeRef,
      systemInstructions: [
        "You are a read-only validator. Do not use tools this turn. Your current reply prefix is REVIEW_TWO, replacing REVIEW_ONE.",
      ],
      prompt:
        "Reply with your current prefix and the candidate contents you reviewed.",
    });
    expect(second.error).toBeNull();
    expect(second.text).toContain("REVIEW_TWO");
    expect(second.text).toContain("CANDIDATE_UNCHANGED");
    expect(second.backendRef).toEqual(resumeRef);
    expect(await readFile(candidate, "utf8")).toBe("CANDIDATE_UNCHANGED");
    const artifact = await store.writeRaw(
      `validator-policy-${randomUUID()}.json`,
      JSON.stringify({ first, second }),
    );
    await store.publish({
      caseId: "validator-instruction-policy-resume",
      outcome: "pass",
      metrics: {
        turns: 2,
        filesystemPolicy: "instruction-only",
        candidateUnchanged: true,
        durableResume: true,
      },
      artifacts: [artifact],
    });
  } finally {
    await harness.closeAll();
  }
}, 300_000);
