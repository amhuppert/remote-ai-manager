import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { translatePortableMcpToCursor } from "../mcp-translation";
import { startMcpRemoteFixture } from "../testing/mcp-remote-fixture";
import {
  CURSOR_MCP_FIXTURE_MARKER_VAR,
  CURSOR_MCP_FIXTURE_TOOL,
  cursorMcpFixtureReply,
} from "../testing/mcp-fixture-server";
import { decodeNativePayload } from "../worker/ipc";
import type { CursorWorkerMcpServer } from "../worker/entry";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { openAcceptanceEvidence } from "./harness";
import {
  createLiveHarness,
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
  frameOfType,
  framesOfType,
  waitUntil,
  type LiveConversation,
  type LiveHarness,
  type LiveWorkspace,
} from "./live-worker";

let harness: LiveHarness;
let evidence: AcceptanceEvidenceStore;
let credential: string;
beforeAll(async () => {
  const opened = await openAcceptanceEvidence(process.env);
  evidence = opened.store;
  credential = opened.secret.value;
  harness = createLiveHarness({
    credential,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });
});
afterAll(async () => {
  await harness?.closeAll();
});

type Servers = Record<string, CursorWorkerMcpServer>;

async function attach(
  workspace: LiveWorkspace,
  servers: Servers,
  ref?: string,
) {
  const live = await harness.startReady({
    sessionName: workspace.name,
    workspace,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
  });
  live.attach({
    mode: ref ? "resume" : "create",
    ref: ref ?? null,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    mcpServers: servers,
  });
  expect(
    await waitUntil(() => !!frameOfType(live.frames, "attachResult"), 90_000),
    "attach settled",
  ).toBe(true);
  expect(frameOfType(live.frames, "attachResult")?.outcome).toBe("attached");
  return live;
}

async function turn(
  live: LiveConversation,
  servers: Servers,
  promptText: string,
) {
  const runId = randomUUID();
  const start = live.frames.length;
  live.startTurn({
    runId,
    promptText,
    images: [],
    structuredOutputInstruction: null,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    mcpServers: servers,
    forceExpirePersistedRun: false,
  });
  expect(
    await waitUntil(
      () =>
        live.frames
          .slice(start)
          .some(
            (frame) => frame.type === "turnSettled" && frame.runId === runId,
          ),
      240_000,
    ),
    "turn settled",
  ).toBe(true);
  const frames = live.frames.slice(start);
  expect(frameOfType(frames, "turnSettled")?.outcome).toBe("completed");
  expect(frameOfType(frames, "inputAccepted")?.runId).toBe(runId);
  const events = framesOfType(frames, "nativeEvent");
  const text = events
    .map((event) => {
      const decoded = decodeNativePayload(event.eventType, event.payload);
      return decoded.ok ? JSON.stringify(decoded.value) : "";
    })
    .join("\n");
  expect(text).not.toContain(credential);
  expect(text).not.toContain("fixture-secret");
  const artifact = await evidence.writeRaw(
    "mcp-parity-" + runId + ".jsonl",
    events.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return { text, artifact };
}

async function ambientProject(workspace: LiveWorkspace, url: string) {
  await mkdir(path.join(workspace.cwd, ".cursor"), { recursive: true });
  const config = JSON.stringify({
    mcpServers: {
      http: { type: "http", url },
      ambientOnly: { type: "http", url },
    },
  });
  await writeFile(path.join(workspace.cwd, ".cursor", "mcp.json"), config);
  await writeFile(path.join(workspace.cwd, ".mcp.json"), config);
}

it("executes stdio, authenticated HTTP and SSE through create, resume, replacement and empty inline configuration", async () => {
  const http = await startMcpRemoteFixture("http", { auth: true });
  const sse = await startMcpRemoteFixture("sse", { auth: true });
  const ambient = await startMcpRemoteFixture("http");
  const workspace = harness.createWorkspace("mcp-parity-" + randomUUID());
  await ambientProject(workspace, ambient.url);
  const marker = "mcp-parity-" + randomUUID();
  const translated = translatePortableMcpToCursor(
    {
      servers: [
        {
          id: "stdio",
          transport: "stdio",
          command: process.execPath,
          args: [
            "--import",
            path.resolve("node_modules/tsx/dist/loader.mjs"),
            path.resolve(
              "src/lib/agent-backends/cursor/testing/mcp-fixture-server.ts",
            ),
          ],
          cwd: process.cwd(),
          env: { [CURSOR_MCP_FIXTURE_MARKER_VAR]: marker },
          enabledTools: [CURSOR_MCP_FIXTURE_TOOL],
          startupTimeoutSec: 20,
          toolTimeoutSec: 10,
        },
        {
          id: "http",
          transport: "streamable-http",
          url: http.url,
          bearerTokenEnvVar: "FIXTURE_BEARER",
          enabledTools: ["allowed"],
          disabledTools: ["denied"],
          startupTimeoutSec: 20,
          toolTimeoutSec: 10,
        },
        {
          id: "sse",
          transport: "sse",
          url: sse.url,
          headers: { Authorization: "Bearer fixture-secret" },
          enabledTools: ["allowed"],
          disabledTools: ["denied"],
          startupTimeoutSec: 20,
          toolTimeoutSec: 10,
        },
      ],
    },
    { FIXTURE_BEARER: "fixture-secret" },
  );
  expect(translated.rejectedServers).toEqual([]);
  const servers = translated.servers;
  const artifacts = [];
  const request =
    "Call mcp_stdio_" +
    CURSOR_MCP_FIXTURE_TOOL +
    ' with value "parity", mcp_http_allowed, and mcp_sse_allowed exactly once each. Use only these MCP tools, then report their returned text.';
  try {
    const created = await attach(workspace, servers);
    const first = await turn(created, servers, request);
    expect(first.text).toContain(cursorMcpFixtureReply(marker, "parity"));
    expect(http.calls).toEqual(["allowed"]);
    expect(sse.calls).toEqual(["allowed"]);
    expect(ambient.activity.requests).toBe(0);
    artifacts.push(first.artifact);
    const ref = frameOfType(created.frames, "refIssued")?.ref;
    expect(ref).toBeTruthy();
    expect((await created.close()).kind).toBe("verified");

    const resumed = await attach(workspace, servers, ref);
    const second = await turn(resumed, servers, request);
    expect(second.text).toContain(cursorMcpFixtureReply(marker, "parity"));
    expect(http.calls).toEqual(["allowed", "allowed"]);
    expect(sse.calls).toEqual(["allowed", "allowed"]);
    artifacts.push(second.artifact);

    const replacement = { replacement: servers.http! };
    const third = await turn(
      resumed,
      replacement,
      "Call mcp_replacement_allowed once and report its returned text. Do not use other tools.",
    );
    expect(third.text).toContain("executed:allowed");
    expect(http.calls).toEqual(["allowed", "allowed", "allowed"]);
    expect(sse.calls).toEqual(["allowed", "allowed"]);
    artifacts.push(third.artifact);

    const fourth = await turn(
      resumed,
      {},
      "Try to call mcp_http_allowed, mcp_sse_allowed, mcp_replacement_allowed and mcp_ambientOnly_allowed if they are available. Do not use shell, files, subagents or network alternatives. Report which tools are unavailable.",
    );
    expect(http.calls).toHaveLength(3);
    expect(sse.calls).toHaveLength(2);
    expect(ambient.activity.requests).toBe(0);
    artifacts.push(fourth.artifact);
    expect((await resumed.close()).kind).toBe("verified");

    const empty = await attach(workspace, {});
    const fifth = await turn(
      empty,
      {},
      "Call mcp_ambientOnly_allowed if available. Do not use shell, files, subagents or network alternatives. Report whether that tool is unavailable.",
    );
    expect(ambient.activity.requests).toBe(0);
    artifacts.push(fifth.artifact);
    expect((await empty.close()).kind).toBe("verified");
    await evidence.publish({
      caseId: "mcp-parity-transports",
      outcome: "pass",
      metrics: {
        create: true,
        resume: true,
        replacement: true,
        emptySend: true,
        emptyCreate: true,
        ambientProjectRequests: ambient.activity.requests,
        httpCalls: http.calls.length,
        sseCalls: sse.calls.length,
        strictAuthoritativeConfig: false,
      },
      artifacts,
    });
  } finally {
    await harness.closeAll();
    await http.close();
    await sse.close();
    await ambient.close();
  }
}, 1_400_000);
