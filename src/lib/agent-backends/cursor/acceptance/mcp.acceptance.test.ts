import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CURSOR_MCP_FIXTURE_MARKER_VAR,
  CURSOR_MCP_FIXTURE_TOOL,
  cursorMcpFixtureReply,
} from "../testing/mcp-fixture-server";
import { CURSOR_CANCEL_SETTLE_TIMEOUT_MS } from "../worker/bounds";
import type { CursorWorkerMcpServer } from "../worker/entry";
import { decodeNativePayload } from "../worker/ipc";
import type { CredentialSecret } from "./credential-scan";
import {
  resolveAcceptanceEvidenceRoot,
  type AcceptanceEvidenceStore,
} from "./evidence";
import { captureProcessBoundaries, openAcceptanceEvidence } from "./harness";
import {
  CURSOR_ACCEPTANCE_MODEL_SELECTION,
  createLiveHarness,
  frameOfType,
  framesOfType,
  waitUntil,
  type LiveConversation,
  type LiveHarness,
} from "./live-worker";
import {
  CURSOR_MCP_BLOCKING_MARKER_VAR,
  CURSOR_MCP_BLOCKING_TOOL,
} from "./mcp-blocking-server";
import { findMarkedPids, isGroupAlive, measureUntil } from "./process-scan";

/**
 * Inline stdio MCP against a live Cursor agent (spec R12.1, R9.3, R14.2).
 *
 * Two claims, and the second is the reason the first is not enough. An inline
 * server has to negotiate and answer a real call under `settingSources: []` —
 * and a cancellation during a call that never returns has to take the server
 * process with it, because an MCP server that outlives its conversation is the
 * same leak a cancelled shell process would be.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = path.resolve(HERE, "..");
const REPO_ROOT = process.cwd();

const ECHO_SERVER_ID = "fixture";
const ECHO_TOOL = `mcp_${ECHO_SERVER_ID}_${CURSOR_MCP_FIXTURE_TOOL}`;
const ECHO_MARKER = `acceptance-${randomUUID().slice(0, 8)}`;
const ECHO_VALUE = "ping-acceptance";
const EXPECTED_ECHO = cursorMcpFixtureReply(ECHO_MARKER, ECHO_VALUE);

const BLOCKING_SERVER_ID = "blocker";
const BLOCKING_TOOL = `mcp_${BLOCKING_SERVER_ID}_${CURSOR_MCP_BLOCKING_TOOL}`;

let store: AcceptanceEvidenceStore;
let secret: CredentialSecret;
let harness: LiveHarness;

function nativeText(
  events: readonly { eventType: string; payload: string }[],
): string {
  return events
    .map((event) => decodeNativePayload(event.eventType, event.payload))
    .map((result) => (result.ok ? JSON.stringify(result.value) : ""))
    .join("");
}

/**
 * The server entries exactly as production composes them: an explicit command,
 * explicit args, a bounded explicit environment, and the repository as cwd so
 * the TypeScript loader resolves. Nothing here reads or writes Cursor's own
 * user or project MCP configuration.
 */
function echoServer(): CursorWorkerMcpServer {
  return {
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.join(ADAPTER_DIR, "testing", "mcp-fixture-server.ts"),
    ],
    env: { [CURSOR_MCP_FIXTURE_MARKER_VAR]: ECHO_MARKER },
    cwd: REPO_ROOT,
  };
}

function blockingServer(marker: string): CursorWorkerMcpServer {
  return {
    command: process.execPath,
    args: [
      "--import",
      "tsx",
      path.join(HERE, "mcp-blocking-server.ts"),
      `--marker=${marker}`,
    ],
    env: { [CURSOR_MCP_BLOCKING_MARKER_VAR]: marker },
    cwd: REPO_ROOT,
  };
}

async function attachedWith(
  sessionName: string,
  mcpServers: Record<string, CursorWorkerMcpServer>,
): Promise<LiveConversation> {
  const live = await harness.startReady({
    sessionName,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
  });
  live.attach({
    mode: "create",
    ref: null,
    modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
    mcpServers,
  });
  expect(
    await waitUntil(
      () => frameOfType(live.frames, "attachResult") !== undefined,
      90_000,
    ),
    `${sessionName}: attach never settled`,
  ).toBe(true);
  expect(frameOfType(live.frames, "attachResult")?.outcome).toBe("attached");
  return live;
}

beforeAll(async () => {
  ({ store, secret } = await openAcceptanceEvidence(process.env));
  harness = createLiveHarness({
    credential: secret.value,
    evidenceRoot: resolveAcceptanceEvidenceRoot(process.env),
  });
});

afterAll(async () => {
  await harness?.closeAll();
});

describe("live inline stdio MCP", () => {
  it("negotiates, calls the deterministic tool once, and returns its result", async () => {
    const live = await attachedWith(`mcp-inline-${randomUUID()}`, {
      [ECHO_SERVER_ID]: echoServer(),
    });
    const runId = randomUUID();

    live.startTurn({
      runId,
      promptText:
        `Call the tool ${ECHO_TOOL} with value "${ECHO_VALUE}" exactly once, ` +
        `then reply with only the tool's returned text and nothing else.`,
      images: [],
      structuredOutputInstruction: null,
      modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
      mcpServers: { [ECHO_SERVER_ID]: echoServer() },
      forceExpirePersistedRun: false,
    });
    expect(
      await waitUntil(
        () => frameOfType(live.frames, "turnSettled") !== undefined,
        240_000,
      ),
      "the MCP turn did not settle",
    ).toBe(true);

    expect(frameOfType(live.frames, "turnSettled")?.outcome).toBe("completed");

    const events = framesOfType(live.frames, "nativeEvent");
    const text = nativeText(events);
    // The reply carries the marker Command Center put in the entry's env, so a
    // matching reply proves the whole path: negotiation, the explicit
    // environment reaching the spawned server, and a real call round-tripping.
    expect(text).toContain(EXPECTED_ECHO);

    const toolEvents = events.filter(
      (event) => event.eventType === "tool_call",
    );
    expect(toolEvents.length).toBeGreaterThan(0);
    // Ordered and monotonically indexed alongside every other native event.
    expect(events.map((event) => event.eventIndex)).toEqual(
      events.map((_event, index) => index),
    );

    const usage = framesOfType(live.frames, "usage");
    expect(usage).toHaveLength(1);
    expect(usage.at(0)?.runId).toBe(runId);
    expect(usage.at(0)?.totalTokens).toBeGreaterThan(0);

    const raw = await store.writeRaw(
      "mcp-native-events.jsonl",
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");

    await store.publish({
      caseId: "mcp-inline-stdio",
      outcome: "pass",
      metrics: {
        toolCallEvents: toolEvents.length,
        markerReachedServer: true,
        settingSources: "empty",
        usageRecords: 1,
        totalTokens: usage.at(0)?.totalTokens ?? null,
        costUsd: null,
        teardown: outcome.kind === "verified" ? outcome.escalation : "failed",
      },
      artifacts: [raw],
    });
  }, 280_000);
});

describe("cancelling a long-running inline MCP call", () => {
  it("terminates the call and the server process, leaving no survivor", async () => {
    const marker = `cc-cursor-acceptance-mcp-${randomUUID().slice(0, 8)}`;
    const live = await attachedWith(`mcp-cancel-${randomUUID()}`, {
      [BLOCKING_SERVER_ID]: blockingServer(marker),
    });
    const runId = randomUUID();

    live.startTurn({
      runId,
      promptText:
        `Call the tool ${BLOCKING_TOOL} with reason "acceptance" and wait for it. ` +
        `Do not give up and do not call any other tool.`,
      images: [],
      structuredOutputInstruction: null,
      modelSelection: CURSOR_ACCEPTANCE_MODEL_SELECTION,
      mcpServers: { [BLOCKING_SERVER_ID]: blockingServer(marker) },
      forceExpirePersistedRun: false,
    });

    expect(
      await waitUntil(() => findMarkedPids(marker).length > 0, 180_000),
      "the marked MCP server never started",
    ).toBe(true);
    const serverPids = findMarkedPids(marker);
    expect(serverPids.length).toBeGreaterThan(0);

    // Let the model actually get inside the call before cancelling.
    expect(
      await waitUntil(
        () =>
          framesOfType(live.frames, "nativeEvent").some(
            (event) => event.eventType === "tool_call",
          ),
        180_000,
      ),
      "the model never entered the blocking tool call",
    ).toBe(true);

    // The MCP server is a child the worker spawned with an explicit env, and it
    // is only readable while the blocked call holds it open.
    const workerPgid =
      frameOfType(live.frames, "ready")?.pgid ?? live.session.pid;
    const boundaries = await captureProcessBoundaries({
      store,
      secret,
      label: "mcp-server-and-worker-group",
      pgids: [workerPgid],
      extraPids: serverPids,
    });
    expect(
      boundaries.pids.length,
      "no live MCP process boundary was read",
    ).toBeGreaterThan(1);
    expect(
      boundaries.findings.map((finding) => finding.sourceLabel),
      "the credential reached the MCP server's argv or environment",
    ).toEqual([]);
    // An inline MCP server is spawned by the worker with an explicit env, so
    // this is where a leak by inheritance would show up first.
    expect(
      boundaries.ambientFindings.map(
        (finding) => `${finding.sourceLabel} (${finding.secretLabel})`,
      ),
      "a third-party credential reached the MCP server's argv or environment",
    ).toEqual([]);

    live.cancel(runId);
    const settleMs = await measureUntil(
      () => frameOfType(live.frames, "cancelResult") !== undefined,
      CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
    );
    expect(
      settleMs,
      "MCP cancellation did not settle in its bound",
    ).not.toBeNull();
    expect(framesOfType(live.frames, "cancelResult")).toHaveLength(1);
    // The run's terminal frame follows its cancellation settlement; awaited
    // rather than assumed, so the case measures the bound instead of racing it.
    expect(
      await waitUntil(
        () => frameOfType(live.frames, "turnSettled") !== undefined,
        CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
      ),
      "the cancelled MCP turn produced no terminal outcome",
    ).toBe(true);
    expect(framesOfType(live.frames, "turnSettled")).toHaveLength(1);
    expect(frameOfType(live.frames, "turnSettled")?.outcome).toBe("aborted");

    const readyFrame = frameOfType(live.frames, "ready");
    const pgid = readyFrame?.pgid ?? live.session.pid;
    const outcome = await live.close();
    expect(outcome.kind).toBe("verified");

    const serverGoneMs = await measureUntil(
      () => findMarkedPids(marker).length === 0,
      CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
    );
    expect(
      serverGoneMs,
      "the marked MCP server process survived the cancelled conversation",
    ).not.toBeNull();
    expect(isGroupAlive(pgid)).toBe(false);

    await store.publish({
      caseId: "cancel-long-mcp-call",
      outcome: "pass",
      metrics: {
        serverProcessesAtCall: serverPids.length,
        cancelSettleMs: settleMs,
        serverGoneMs,
        boundMs: CURSOR_CANCEL_SETTLE_TIMEOUT_MS,
        terminalOutcome: "aborted",
        survivingProcesses: 0,
        workerGroupSurvived: false,
        processBoundariesScanned: boundaries.sources.length,
        boundaryFindings: boundaries.findings.length,
        ambientCredentialFindings: boundaries.ambientFindings.length,
      },
      artifacts: [boundaries.artifact],
    });
  }, 280_000);
});
