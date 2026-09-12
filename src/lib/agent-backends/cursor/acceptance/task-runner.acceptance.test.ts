import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createCursorTaskRunner } from "../task-runner";
import { decodeCursorTaskRef } from "../task-ref";
import { translatePortableMcpToCursor } from "../mcp-translation";
import { prepareCursorCapabilityDelivery } from "../capability-delivery";
import { resolveCursorModelForProduction } from "../production-wiring";
import { createCursorContinuityAdapter } from "../continuity";
import { createCursorContinuityBindingResolver } from "../continuity-binding";
import { getConversation, getSession } from "@/lib/state-store";
import type { AgentTaskRequest, AgentTaskResult } from "../../task";
import type { CursorWorkerTransport } from "../worker-port";
import { resolveAcceptanceEvidenceRoot } from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  createLiveHarness,
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
  waitUntil,
  type LiveHarness,
} from "./live-worker";
import { findGroupPids } from "./process-scan";
import { readProcessEnvironSource } from "./credential-scan";
import { conversationTranscriptFrame } from "../../transcript";
import { projectCursorStoredToolResultBlocks } from "../transcript-projections";
import { agentSessionRefSchema } from "@/lib/shared/schemas";

let harness: LiveHarness;
let cwd: string;
const pids: number[] = [];
const workerStores: string[] = [];
const root = resolveAcceptanceEvidenceRoot(process.env);
const marker = `TASK-${randomUUID()}`;
const storePath = (id: string) => path.join(root, "task-stores", id);

beforeAll(async () => {
  const { secret } = await openAcceptanceEvidence(process.env);
  harness = createLiveHarness({ credential: secret.value, evidenceRoot: root });
  cwd = harness.createWorkspace(`task-case-${randomUUID()}`).cwd;
});
afterAll(async () => {
  await harness?.closeAll();
});

function runner(onAccepted?: () => void) {
  const transport: CursorWorkerTransport = {
    async start(input) {
      const result = await harness.transport.start({
        ...input,
        onFrame(frame) {
          input.onFrame(frame);
          if (frame.type === "inputAccepted") onAccepted?.();
        },
      });
      if (result.kind === "ready") {
        pids.push(result.session.pid);
        workerStores.push(input.storePath);
        const environment = await readProcessEnvironSource(result.session.pid);
        expect(environment.records.length).toBeGreaterThan(0);
        expect(
          environment.records.some((record) =>
            record.startsWith("CURSOR_API_KEY="),
          ),
        ).toBe(false);
      }
      return result;
    },
    find: (id) => harness.transport.find(id),
    closeAll: () => harness.closeAll(),
  };
  return createCursorTaskRunner({
    transport,
    storePath,
    removeStore: (id) => rm(storePath(id), { recursive: true, force: true }),
    newRunId: randomUUID,
    now: Date.now,
    resolveModel: (selection, cwd) =>
      resolveCursorModelForProduction(cwd, selection),
    translatePortableMcpToCursor,
    stallTimeoutMs: 90_000,
    cancelSettleTimeoutMs: 10_000,
    prepareCapabilities: (input, storePath) =>
      prepareCursorCapabilityDelivery({
        worktreePath: cwd,
        home: cwd,
        storePath,
        bundle: null,
        resumed: input.resumeRef != null,
        hermetic: input.executionProfile === "isolated-one-shot",
        resolved: { backend: "cursor", kinds: [] },
      }),
  });
}

function request(prompt: string): AgentTaskRequest {
  return {
    executionClass: "nongoverned-task",
    workingDirectory: cwd,
    prompt,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    timeoutMs: 180_000,
    autonomous: true,
  };
}

async function persistResult(name: string, result: AgentTaskResult) {
  const { store } = await openAcceptanceEvidence(process.env);
  const artifact = await store.writeRaw(name, JSON.stringify(result));
  await store.publish({
    caseId: name,
    outcome: "pass",
    metrics: {
      transcriptEntries: result.transcript?.length ?? 0,
      timedOut: result.timedOut,
    },
    artifacts: [artifact],
  });
}

it("continues a durable task in a separate worker without replaying prior output", async () => {
  const first = await runner().run(
    request(
      `Remember the token ${marker}. Reply exactly STORED. Do not use tools.`,
    ),
  );
  expect(first.error).toBeNull();
  expect(first.text).toContain("STORED");
  expect(first.backendRef).toBeTruthy();
  if (!first.backendRef) throw new Error("missing task ref");
  const refFile = path.join(root, "task-ref.json");
  await writeFile(refFile, JSON.stringify(first.backendRef), { mode: 0o600 });
  const durableRef = agentSessionRefSchema.parse(
    JSON.parse(await readFile(refFile, "utf8")),
  );
  const decoded = decodeCursorTaskRef(durableRef);
  expect(
    (await readdir(storePath(`task-${decoded.taskId}`))).length,
  ).toBeGreaterThan(0);
  const second = await runner().run({
    ...request(
      "What token did I ask you to remember? Reply with only that token.",
    ),
    resumeRef: durableRef,
  });
  expect(second.error).toBeNull();
  expect(second.text).toContain(marker);
  expect(second.text).not.toContain("STORED");
  expect(second.backendRef).toEqual(first.backendRef);
  const continuity = createCursorContinuityAdapter({
    transport: harness.transport,
    resolveBinding: createCursorContinuityBindingResolver({
      getConversation,
      getSession,
      storePath,
      resolveModel: (selection, projectPath) =>
        resolveCursorModelForProduction(projectPath, selection),
    }),
  });
  const context = {
    projectPath: cwd,
    sessionName: "task",
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
  };
  expect(await continuity.validate(durableRef, context)).toEqual({
    status: "valid",
  });
  expect(await continuity.resumeOrRecover(durableRef, context)).toEqual({
    ref: durableRef,
    recovered: false,
  });
  expect(harness.transport.find(`task-${decoded.taskId}`)).toBeNull();
  expect(new Set(pids).size).toBe(pids.length);
  for (const pid of pids) expect(await findGroupPids(pid)).toEqual([]);
  await persistResult("task-continuation-first.json", first);
  await persistResult("task-continuation-second.json", second);
});

it("isolated tasks produce structured text with no file or tool side effects", async () => {
  const forbidden = path.join(cwd, "forbidden.txt");
  const result = await runner().run({
    ...request(
      `Use a shell or file tool to write ${forbidden}, then compute 17 times 19. If tools are unavailable just answer the calculation.`,
    ),
    executionProfile: "isolated-one-shot",
    outputSchema: {
      type: "object",
      properties: { answer: { type: "integer" } },
      required: ["answer"],
      additionalProperties: false,
    },
    ccSessionScope: {
      project: "forbidden",
      session: "forbidden",
      conversationId: "forbidden",
    },
  });
  expect(result.error).toBeNull();
  expect(result.backendRef).toBeNull();
  expect(result.text).toContain("323");
  const isolatedStore = workerStores.at(-1);
  if (!isolatedStore) throw new Error("missing isolated worker store");
  await expect(stat(isolatedStore)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(stat(forbidden)).rejects.toMatchObject({ code: "ENOENT" });
  expect(
    result.transcript?.some((entry) => {
      const frame = conversationTranscriptFrame(entry);
      return (
        frame.type === "tool_result" ||
        frame.content?.some((block) => block.type === "tool_use")
      );
    }),
  ).toBe(false);
  for (const pid of pids) expect(await findGroupPids(pid)).toEqual([]);
  await persistResult("task-isolated.json", result);
});

it("cancels an authenticated task and verifies its worker group is gone", async () => {
  const controller = new AbortController();
  const result = await runner(() => controller.abort()).run({
    ...request("Use the shell to wait for sixty seconds, then reply FINISHED."),
    signal: controller.signal,
  });
  expect(result.timedOut).toBe(true);
  expect(result.error).toBeTruthy();
  for (const pid of pids) expect(await findGroupPids(pid)).toEqual([]);
  await persistResult("task-cancelled.json", result);
});

it("delivers the trusted task's CC identity to actual shell tools", async () => {
  const result = await runner().run({
    ...request(
      "Use a shell to print CC_PROJECT, CC_SESSION and CC_CONVERSATION_ID. Reply with that output.",
    ),
    ccSessionScope: {
      project: "task-fixture-project",
      session: "task-fixture-session",
      conversationId: "task-fixture-conversation",
    },
  });
  expect(result.error).toBeNull();
  expect(result.text).toContain("task-fixture-project");
  expect(result.text).toContain("task-fixture-session");
  expect(result.text).toContain("task-fixture-conversation");
  const toolResults = result.transcript?.flatMap((entry) => {
    const frame = conversationTranscriptFrame(entry);
    return frame.type === "tool_result"
      ? (projectCursorStoredToolResultBlocks(frame.raw) ?? [])
      : [];
  });
  expect(JSON.stringify(toolResults)).toContain("task-fixture-project");
  expect(JSON.stringify(toolResults)).toContain("task-fixture-session");
  expect(JSON.stringify(toolResults)).toContain("task-fixture-conversation");
  for (const pid of pids) expect(findGroupPids(pid)).toEqual([]);
  await persistResult("task-cc-identity.json", result);
});

it("recovers an accepted continued task after its owning parent process dies", async () => {
  const before = await runner().run(
    request(`Remember ${marker}. Reply STORED.`),
  );
  expect(before.error).toBeNull();
  if (!before.backendRef) throw new Error("missing continuation before crash");
  const inputFile = path.join(root, "parent-input.json");
  await writeFile(
    inputFile,
    JSON.stringify({ root, cwd, ref: before.backendRef }),
    { mode: 0o600 },
  );
  const script = path.join(root, "task-parent.mjs");
  execFileSync(
    "bun",
    [
      "build",
      "src/lib/agent-backends/cursor/acceptance/task-parent.ts",
      "--target=node",
      "--format=esm",
      "--external",
      "@cursor/sdk",
      `--outfile=${script}`,
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  const parent = spawn(process.execPath, [script, inputFile], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let diagnostics = "";
  parent.stdout.on("data", (data) => {
    output += String(data);
  });
  parent.stderr.on("data", (data) => {
    diagnostics += String(data);
  });
  try {
    expect(
      await waitUntil(() => output.includes('"accepted":true'), 60_000),
      diagnostics,
    ).toBe(true);
    const accepted = output
      .split("\n")
      .find((line) => line.includes('"accepted":true'));
    if (!accepted) throw new Error("no accepted frame");
    const pid = JSON.parse(accepted).pid;
    expect(typeof pid).toBe("number");
    const exited = once(parent, "exit");
    parent.kill("SIGKILL");
    await exited;
    expect(await waitUntil(() => findGroupPids(pid).length === 0, 20_000)).toBe(
      true,
    );
    const recovered = await runner().run({
      ...request(
        "Return only the token I asked you to remember before the wait command.",
      ),
      resumeRef: before.backendRef,
    });
    expect(recovered.error).toBeNull();
    expect(recovered.text).toContain(marker);
    expect(recovered.text).not.toContain("WAIT_DONE");
    for (const workerPid of pids) expect(findGroupPids(workerPid)).toEqual([]);
    await persistResult("task-parent-death-recovered.json", recovered);
  } finally {
    if (parent.exitCode === null && parent.signalCode === null)
      parent.kill("SIGKILL");
  }
});
