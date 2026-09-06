import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type {
  ConversationBackendEvent,
  ConversationBackendTurnResult,
} from "../conversation";
import type { PortableMcpConfig } from "../portable-mcp";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { CursorConversationRuntime } from "./conversation-runtime";
import { translatePortableMcpToCursor } from "./mcp-translation";
import { CURSOR_DEFAULT_MODEL } from "./model-policy";
import {
  CURSOR_MCP_FIXTURE_MARKER_VAR,
  CURSOR_MCP_FIXTURE_TOOL,
  cursorMcpFixtureReply,
} from "./testing/mcp-fixture-server";
import type { CursorWorkerFrame } from "./worker/ipc";
import type {
  CursorWorkerAgent,
  CursorWorkerAttachOptions,
  CursorWorkerChannel,
  CursorWorkerProcessControl,
  CursorWorkerRun,
  CursorWorkerRunResult,
  CursorWorkerSdk,
  CursorWorkerSendMessage,
  CursorWorkerSendOptions,
} from "./worker/entry";
import { startCursorWorker } from "./worker/entry";
import type {
  CursorProcessHost,
  CursorSpawnRequest,
  CursorSpawnedProcess,
} from "./worker/process-host";
import { createCursorWorkerSupervisor } from "./worker/supervisor";
import type {
  CursorWorkerStartInput,
  CursorWorkerTransport,
} from "./worker-port";

/**
 * Inline stdio MCP end to end (spec D18, R10).
 *
 * The only thing faked here is the Cursor model loop: the conversation
 * runtime, the supervisor, the IPC codec, the worker runtime, the portable
 * translation, and the MCP server are all real, and the MCP session is a real
 * negotiation with a real child process launched from the entry Command Center
 * produced. That is what makes the assertions below claims about production —
 * the stand-in SDK receives `mcpServers` exactly as `@cursor/sdk` would and
 * spends it on a genuine MCP client.
 *
 * The Cursor model loop cannot run without a credential, so the authenticated
 * matrix stays with the acceptance suite; what is provable without one is
 * proven here.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SERVER = path.join(HERE, "testing", "mcp-fixture-server.ts");
/** The fixture is TypeScript, so the child needs a loader. */
const FIXTURE_ARGS = ["--import", "tsx", FIXTURE_SERVER];

const CONVERSATION_ID = "conv-mcp-inline";
const API_KEY = "cursor-key-sentinel-mcp-7c1e";
const MARKER = "marker-7c1e";
const PROMPT = "ping-42";
const EXPECTED_REPLY = cursorMcpFixtureReply(MARKER, PROMPT);
const FIXTURE_SERVER_ID = "fixture";
const FIXTURE_QUALIFIED_TOOL = `mcp_${FIXTURE_SERVER_ID}_${CURSOR_MCP_FIXTURE_TOOL}`;
const MODEL_SELECTION = {
  modelId: CURSOR_DEFAULT_MODEL,
  parameters: { fast: "true" },
} as const;

const TARGET: ConversationTarget = {
  scope: "session",
  projectName: "command-center",
  sessionName: "cursor-mcp",
  conversationId: CONVERSATION_ID,
};

const PREFLIGHT_DIAGNOSTICS = {
  sdkPackage: "@cursor/sdk",
  requiredSdkVersion: "1.0.28",
  installedSdkVersion: "1.0.28",
  platformPackage: "@cursor/sdk-linux-x64",
  installedPlatformVersion: "1.0.28",
  host: "linux-x64",
  nodeVersion: "v22.14.0",
  requiredNodeVersion: ">=22.13",
  model: CURSOR_DEFAULT_MODEL,
};

const BOUNDS = {
  readyTimeoutMs: 10_000,
  cancelGraceMs: 100,
  exitGraceMs: 5_000,
  termGraceMs: 200,
  killConfirmMs: 200,
  probeIntervalMs: 10,
  idleTtlMs: 60_000,
  workerParentPollIntervalMs: 30_000,
  workerTerminationGraceMs: 20,
};

// ---------------------------------------------------------------------------
// The stand-in SDK: everything below it is a real MCP session
// ---------------------------------------------------------------------------

interface McpNegotiation {
  serverId: string;
  tools: string[];
}

interface McpToolCall {
  serverId: string;
  tool: string;
  value: string;
  reply: string;
}

interface SdkLog {
  creates: CursorWorkerAttachOptions[];
  resumes: { ref: string; options: CursorWorkerAttachOptions }[];
  sendOptions: CursorWorkerSendOptions[];
  negotiations: McpNegotiation[];
  calls: McpToolCall[];
}

function newSdkLog(): SdkLog {
  return {
    creates: [],
    resumes: [],
    sendOptions: [],
    negotiations: [],
    calls: [],
  };
}

/** The MCP result's first text block, narrowed rather than cast. */
const mcpTextResultSchema = z.object({
  content: z.array(z.object({ text: z.string() })).min(1),
});

function readReplyText(result: unknown): string {
  const parsed = mcpTextResultSchema.safeParse(result);
  return parsed.success ? (parsed.data.content[0]?.text ?? "") : "";
}

/**
 * Opens one real MCP client per configured server, exactly as an MCP host
 * would, and remembers what each advertised. A server the translation left out
 * therefore cannot be reached at all — which is what makes the disabled-server
 * claim observable rather than asserted about a map alone.
 */
async function openMcpClients(
  options: CursorWorkerAttachOptions,
  log: SdkLog,
): Promise<Map<string, Client>> {
  const clients = new Map<string, Client>();
  for (const [serverId, server] of Object.entries(options.mcpServers)) {
    const client = new Client(
      { name: "cursor-inline-test-host", version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(
      new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: server.env,
        ...(server.cwd !== undefined ? { cwd: server.cwd } : {}),
        stderr: "pipe",
      }),
    );
    const listed = await client.listTools();
    log.negotiations.push({
      serverId,
      tools: listed.tools.map((tool) => tool.name),
    });
    clients.set(serverId, client);
  }
  return clients;
}

function runOf(events: readonly unknown[]): CursorWorkerRun {
  return {
    async *stream(): AsyncIterable<unknown> {
      for (const event of events) yield event;
    },
    async wait(): Promise<CursorWorkerRunResult> {
      return { status: "finished" };
    },
    async cancel(): Promise<void> {},
  };
}

class InlineMcpAgent implements CursorWorkerAgent {
  private callCounter = 0;

  constructor(
    readonly agentId: string,
    private readonly clients: Map<string, Client>,
    private readonly log: SdkLog,
  ) {}

  async send(
    message: CursorWorkerSendMessage,
    options: CursorWorkerSendOptions,
  ): Promise<CursorWorkerRun> {
    this.log.sendOptions.push(options);
    const client = this.clients.get(FIXTURE_SERVER_ID);
    if (client === undefined) {
      throw new Error(`no MCP client for ${FIXTURE_SERVER_ID}`);
    }

    const result = await client.callTool({
      name: CURSOR_MCP_FIXTURE_TOOL,
      arguments: { value: message.text },
    });
    const reply = readReplyText(result);
    this.log.calls.push({
      serverId: FIXTURE_SERVER_ID,
      tool: CURSOR_MCP_FIXTURE_TOOL,
      value: message.text,
      reply,
    });

    this.callCounter += 1;
    const callId = `call-${this.callCounter}`;
    // The native shapes the SDK emits around a tool call: the running call,
    // its terminal state carrying the MCP server's own result, and the
    // assistant message that reports it.
    return runOf([
      {
        type: "tool_call",
        agent_id: this.agentId,
        call_id: callId,
        name: FIXTURE_QUALIFIED_TOOL,
        args: { value: message.text },
        status: "running",
      },
      {
        type: "tool_call",
        agent_id: this.agentId,
        call_id: callId,
        name: FIXTURE_QUALIFIED_TOOL,
        status: "completed",
        result,
      },
      {
        type: "assistant",
        agent_id: this.agentId,
        message: {
          role: "assistant",
          content: [{ type: "text", text: reply }],
        },
      },
    ]);
  }

  async dispose(): Promise<void> {
    for (const client of this.clients.values()) await client.close();
    this.clients.clear();
  }
}

function createInlineMcpSdk(log: SdkLog, agentId: string): CursorWorkerSdk {
  return {
    async verifyCredential(): Promise<void> {},
    async create(options) {
      log.creates.push(options);
      return new InlineMcpAgent(
        agentId,
        await openMcpClients(options, log),
        log,
      );
    },
    async resume(ref, options) {
      log.resumes.push({ ref, options });
      return new InlineMcpAgent(ref, await openMcpClients(options, log), log);
    },
  };
}

// ---------------------------------------------------------------------------
// The worker, in process: the real worker runtime behind the real supervisor
// ---------------------------------------------------------------------------

class InProcessControl implements CursorWorkerProcessControl {
  readonly umasks: number[] = [];

  constructor(
    readonly pid: number,
    private readonly onExit: () => void,
  ) {}

  processGroupId(): number {
    return this.pid;
  }

  setUmask(mask: number): void {
    this.umasks.push(mask);
  }

  parentPid(): number {
    return process.pid;
  }

  isAlive(): boolean {
    return true;
  }

  signalGroup(): void {}

  ignoreTermination(): void {}

  exit(): void {
    this.onExit();
  }
}

/**
 * A process host whose "spawned process" is the real worker runtime running in
 * this process, wired to the supervisor through the same frames a fork would
 * carry. The IPC codec, handshake, attach, turn, and teardown paths are the
 * production ones; only the process boundary is collapsed.
 */
class InProcessWorkerHost implements CursorProcessHost {
  readonly requests: CursorSpawnRequest[] = [];
  readonly umasks: number[] = [];
  private readonly aliveGroups = new Set<number>();
  private readonly ticks = new Map<number, string | null>();
  private nextPid = 7100;

  constructor(private readonly createSdk: () => CursorWorkerSdk) {}

  spawn(request: CursorSpawnRequest): CursorSpawnedProcess {
    this.requests.push(request);
    const pid = this.nextPid;
    this.nextPid += 1;
    this.aliveGroups.add(pid);
    this.ticks.set(pid, `${pid}00`);

    const parentListeners: ((value: unknown) => void)[] = [];
    const exitListeners: ((
      code: number | null,
      signal: string | null,
    ) => void)[] = [];
    let toWorker: ((value: unknown) => void) | null = null;
    let workerDisconnect: (() => void) | null = null;
    let running = true;

    const control = new InProcessControl(pid, () => {
      if (!running) return;
      running = false;
      this.aliveGroups.delete(pid);
      this.ticks.set(pid, null);
      for (const listener of exitListeners) listener(0, null);
    });

    const channel: CursorWorkerChannel = {
      send: (frame) => {
        for (const listener of parentListeners) listener(frame);
      },
      onMessage: (listener) => {
        toWorker = listener;
      },
      onDisconnect: (listener) => {
        workerDisconnect = listener;
      },
    };

    const sdk = this.createSdk();
    startCursorWorker({
      channel,
      process: control,
      loadSdk: async () => sdk,
      nodeVersion: process.version,
      sdkVersion: "1.0.28",
    });
    this.umasks.push(...control.umasks);

    return {
      pid,
      send: (frame) => {
        if (!running) throw new Error("channel closed");
        toWorker?.(frame);
      },
      onMessage: (listener) => parentListeners.push(listener),
      onExit: (listener) => exitListeners.push(listener),
      onError: () => {},
      disconnect: () => workerDisconnect?.(),
    };
  }

  processGroupId(pid: number): number | null {
    return this.ticks.has(pid) ? pid : null;
  }

  async startTicks(pid: number): Promise<string | null> {
    return this.ticks.get(pid) ?? null;
  }

  isGroupAlive(pgid: number): boolean {
    return this.aliveGroups.has(pgid);
  }

  signalGroup(): void {}
}

// ---------------------------------------------------------------------------
// The chain under test
// ---------------------------------------------------------------------------

interface LiveRun {
  result: ConversationBackendTurnResult;
  events: ConversationBackendEvent[];
  frames: CursorWorkerFrame[];
  log: SdkLog;
  portable: PortableMcpConfig;
  worktree: string;
  fixtureHome: string;
  close(): Promise<void>;
}

function teeFrames(
  inner: CursorWorkerTransport,
  frames: CursorWorkerFrame[],
): CursorWorkerTransport {
  return {
    start: (input: CursorWorkerStartInput) =>
      inner.start({
        ...input,
        onFrame: (frame) => {
          frames.push(frame);
          input.onFrame(frame);
        },
      }),
    find: (conversationId) => inner.find(conversationId),
    closeAll: () => inner.closeAll(),
  };
}

/**
 * The cascade's output for this conversation: one enabled stdio fixture and
 * one disabled server whose command does not exist. If the disabled entry ever
 * reached the SDK, the negotiation above would fail loudly rather than pass
 * quietly.
 */
function portableConfig(fixtureHome: string, cwd: string): PortableMcpConfig {
  return {
    servers: [
      {
        id: FIXTURE_SERVER_ID,
        transport: "stdio",
        command: process.execPath,
        args: FIXTURE_ARGS,
        env: { [CURSOR_MCP_FIXTURE_MARKER_VAR]: MARKER, HOME: fixtureHome },
        cwd,
      },
      {
        id: "disabled",
        transport: "stdio",
        command: "cursor-mcp-must-never-spawn",
        enabled: false,
      },
    ],
  };
}

async function driveTurn(options: {
  persistedRef: string | null;
  worktree: string;
  fixtureHome: string;
}): Promise<LiveRun> {
  const log = newSdkLog();
  const frames: CursorWorkerFrame[] = [];
  const events: ConversationBackendEvent[] = [];
  const host = new InProcessWorkerHost(() =>
    createInlineMcpSdk(log, "agent-inline-1"),
  );
  // The worker's cwd is the conversation's worktree; the fixture entry names
  // the repository root because its loader resolves from there.
  const portable = portableConfig(options.fixtureHome, process.cwd());

  const transport = teeFrames(
    createCursorWorkerSupervisor({
      host,
      runStaticPreflight: async () => ({
        ok: true,
        diagnostics: PREFLIGHT_DIAGNOSTICS,
      }),
      readCredential: () => API_KEY,
      workerScriptPath: () => "/app/dist/cursor-worker/worker.mjs",
      workerExecArgv: () => [],
      buildChildEnv: () => ({ PATH: process.env.PATH ?? "/usr/bin" }),
      getServerUrl: () => "http://127.0.0.1:3000",
      getApiToken: () => "token",
      getConfigDir: () => path.join(options.worktree, "config"),
      newWorkerId: () => "worker-mcp-1",
      bounds: BOUNDS,
    }),
    frames,
  );

  let runCounter = 0;
  const runtime = new CursorConversationRuntime(
    {
      executionClass: "ordinary-conversation" as const,
      conversationId: CONVERSATION_ID,
      projectPath: options.worktree,
      projectName: "command-center",
      conversationTarget: TARGET,
      worktreePath: options.worktree,
      persistedRef:
        options.persistedRef === null
          ? null
          : { backend: CURSOR_BACKEND_ID, ref: options.persistedRef },
      modelSelection: MODEL_SELECTION,
      sessionInstructions: [],
      tooling: { portableMcp: portable },
    },
    {
      transport,
      storePath: (conversationId) =>
        path.join(options.worktree, "store", conversationId),
      resolveModel: async (selection) => ({
        ok: true,
        selection,
      }),
      translatePortableMcpToCursor,
      newRunId: () => `run-${++runCounter}`,
      now: () => Date.now(),
      stallTimeoutMs: 10_000,
      cancelSettleTimeoutMs: 1_000,
    },
  );

  const result = await runtime.sendTurn({
    promptText: PROMPT,
    imageRefs: [],
    sessionInstructions: [],
    modelSelection: MODEL_SELECTION,
    autonomous: false,
    signal: new AbortController().signal,
    onEvent: (event) => {
      events.push(event);
    },
  });

  return {
    result,
    events,
    frames,
    log,
    portable,
    worktree: options.worktree,
    fixtureHome: options.fixtureHome,
    close: () => runtime.close(),
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every entry under a Cursor configuration root, sorted. The repository ships a
 * tracked `.cursor/rules`, so the claim worth making about the project root is
 * that the run left it byte-identical — not that it is absent.
 */
async function cursorConfigListing(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { recursive: true });
    return entries.map((entry) => String(entry)).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------

describe("inline stdio MCP through the worker path", () => {
  let root: string;
  let live: LiveRun;
  const projectCursorRoot = path.join(process.cwd(), ".cursor");
  let projectCursorBefore: string[];

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cursor-mcp-inline-"));
    projectCursorBefore = await cursorConfigListing(projectCursorRoot);
    live = await driveTurn({
      persistedRef: null,
      worktree: path.join(root, "worktree"),
      fixtureHome: path.join(root, "home"),
    });
  }, 60_000);

  afterAll(async () => {
    await live?.close();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }, 30_000);

  it("negotiates the fixture server and lists its deterministic tool", () => {
    expect(live.log.negotiations).toEqual([
      { serverId: FIXTURE_SERVER_ID, tools: [CURSOR_MCP_FIXTURE_TOOL] },
    ]);
  });

  it("makes exactly one call that returns the expected result", () => {
    expect(live.log.calls).toEqual([
      {
        serverId: FIXTURE_SERVER_ID,
        tool: CURSOR_MCP_FIXTURE_TOOL,
        value: PROMPT,
        reply: EXPECTED_REPLY,
      },
    ]);
    // The reply embeds the marker Command Center put in the entry's `env`, so
    // a matching reply is proof the explicit environment reached the spawn.
    expect(EXPECTED_REPLY).toContain(MARKER);
  });

  it("attaches and sends under settingSources [] with the cascade's servers only", () => {
    const attach = live.log.creates[0];
    expect(attach?.settingSources).toEqual([]);
    expect(attach?.sandboxEnabled).toBe(false);
    expect(attach?.autoReview).toBe(false);
    expect(attach?.mcpServers).toEqual({
      [FIXTURE_SERVER_ID]: {
        command: process.execPath,
        args: FIXTURE_ARGS,
        env: {
          [CURSOR_MCP_FIXTURE_MARKER_VAR]: MARKER,
          HOME: live.fixtureHome,
        },
        cwd: process.cwd(),
      },
    });
    // The disabled entry never became part of the config the worker received.
    expect(Object.keys(attach?.mcpServers ?? {})).not.toContain("disabled");
    expect(live.log.sendOptions[0]?.mcpServers).toEqual(attach?.mcpServers);
  });

  it("emits ordered native tool lifecycle events over the worker channel", () => {
    const native = live.frames.filter((frame) => frame.type === "nativeEvent");
    expect(native.map((frame) => frame.eventType)).toEqual([
      "tool_call",
      "tool_call",
      "assistant",
    ]);
    expect(native.map((frame) => frame.eventIndex)).toEqual([0, 1, 2]);
  });

  it("projects the same activity as ordered neutral tool lifecycle events", () => {
    const blocks = live.events
      .filter((event) => event.type === "content")
      .map((event) => event.block);

    expect(blocks).toEqual([
      {
        type: "tool_use",
        id: "call-1",
        name: FIXTURE_QUALIFIED_TOOL,
        input: { value: PROMPT },
      },
      {
        type: "tool_result",
        tool_use_id: "call-1",
        content: expect.stringContaining(EXPECTED_REPLY),
      },
      { type: "text", text: EXPECTED_REPLY },
    ]);
    expect(
      live.events
        .filter((event) => event.type === "transcript_entry")
        .map((event) => event.entry.type),
    ).toEqual(["assistant", "tool_result", "assistant"]);
    expect(live.result.finalText).toBe(EXPECTED_REPLY);
    expect(live.result.failure).toBeNull();
  });

  it("writes no Cursor user or project configuration", async () => {
    // The three roots a Cursor MCP config would land in: the HOME the fixture
    // ran under, the conversation's own worktree, and the project directory the
    // MCP child was spawned in.
    expect(await exists(path.join(live.fixtureHome, ".cursor"))).toBe(false);
    expect(await exists(path.join(live.worktree, ".cursor"))).toBe(false);
    expect(await cursorConfigListing(projectCursorRoot)).toEqual(
      projectCursorBefore,
    );
    expect(projectCursorBefore).not.toContain("mcp.json");
  });
});

describe("inline stdio MCP across a restart", () => {
  it("re-passes the same map and settingSources [] when resuming a persisted ref", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "cursor-mcp-resume-"));
    try {
      const live = await driveTurn({
        persistedRef: "agent-persisted-1",
        worktree: path.join(root, "worktree"),
        fixtureHome: path.join(root, "home"),
      });
      try {
        expect(live.log.creates).toEqual([]);
        const resumed = live.log.resumes[0];
        expect(resumed?.ref).toBe("agent-persisted-1");
        expect(resumed?.options.settingSources).toEqual([]);
        expect(resumed?.options.mcpServers).toEqual({
          [FIXTURE_SERVER_ID]: {
            command: process.execPath,
            args: FIXTURE_ARGS,
            env: {
              [CURSOR_MCP_FIXTURE_MARKER_VAR]: MARKER,
              HOME: live.fixtureHome,
            },
            cwd: process.cwd(),
          },
        });
        // The resumed agent reached the same server, not just the same config.
        expect(live.log.negotiations).toEqual([
          { serverId: FIXTURE_SERVER_ID, tools: [CURSOR_MCP_FIXTURE_TOOL] },
        ]);
        expect(live.log.calls[0]?.reply).toBe(EXPECTED_REPLY);
      } finally {
        await live.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
