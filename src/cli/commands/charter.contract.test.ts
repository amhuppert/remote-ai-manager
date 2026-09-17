import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentAuth } from "@/lib/agent-gateway/token";
import { createSessionAlignmentAgentRouteHandlers } from "@/lib/session-alignment/agent-route-handlers";
import { createSessionAlignmentRouteHandlers } from "@/lib/session-alignment/route-handlers";
import { createSessionAlignmentRepo } from "@/lib/session-alignment/repo";
import type { CharterMirrorWriteResult } from "@/lib/session-alignment/mirror";
import {
  SCAFFOLD_TEMPLATE,
  computeAlignmentHash,
  renderAlignmentPromptSection,
  usesDigestPointer,
} from "@/lib/session-alignment/render";
import {
  createSessionAlignmentService,
  type SessionAlignmentService,
} from "@/lib/session-alignment/service";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import type { ActiveConversationTurnDescription } from "@/lib/workflows/conversation/manager";

import { runCcWithHost } from "../testing/domain-runtime";
import type { CliEnv, CliHost } from "../transport";

/**
 * Contract layer per doc 01 §8: the real CLI core driving the real
 * session-alignment agent handlers in-process over a real :memory: store, with
 * the real token gate. Covers BOTH `cctl charter write` and `cctl decisions
 * propose` — they are sibling commands in the same alignment domain sharing one
 * service, repo, and store, so one fixture exercises the whole submission path.
 *
 * Each test submits via the CLI, then reads the state back through the EXISTING
 * browser-facing GET /alignment route handler (same service instance) — proving
 * the acceptance criterion that a CLI submission lands as the pending-approval /
 * pending-proposal state the approval UI already renders.
 */

const PROJECT_NAME = "cc";
const PROJECT_PATH = "/repos/cc";
const SESSION = "sess";
const WORKTREE = `${PROJECT_PATH}/.worktrees/${SESSION}`;
const CONVERSATION_ID = "conv-contract";
const TOKEN = "contract-token";

let dir: string;
let fixture: PersistenceFixture;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cctl-align-"));
  await writeFile(path.join(dir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  fixture = createPersistenceFixture();
  fixture.seedProject(PROJECT_PATH);
  fixture.seedSession(PROJECT_PATH, SESSION, {
    worktreePath: WORKTREE,
    creationMode: "normal",
  });
});

afterEach(async () => {
  fixture.close();
  await rm(dir, { recursive: true, force: true });
});

/** The real alignment service bound to the fixture DB, deterministic seams. */
function buildService(): SessionAlignmentService {
  const repo = createSessionAlignmentRepo(fixture.db);
  let idCounter = 0;
  let clock = 0;
  return createSessionAlignmentService({
    repo,
    render: {
      renderAlignmentPromptSection,
      computeAlignmentHash,
      usesDigestPointer,
      scaffoldTemplate: SCAFFOLD_TEMPLATE,
    },
    mirror: {
      async write(): Promise<CharterMirrorWriteResult> {
        return { ok: true, filePath: ".cc/session-alignment/charter.md" };
      },
    },
    snapshot: {
      write() {
        return Promise.resolve({
          filePath: ".cc/session-alignment/snapshots/frozen.md",
          created: true,
        });
      },
    },
    broadcast: () => ({ delivered: true }),
    promptQueue: {
      async enqueue() {},
    },
    loadSession(projectPath, sessionName) {
      return Promise.resolve(
        projectPath === PROJECT_PATH && sessionName === SESSION
          ? { worktreePath: WORKTREE, creationMode: "normal" as const }
          : null,
      );
    },
    now: () => {
      clock += 1000;
      return new Date(clock).toISOString();
    },
    newId: () => {
      idCounter += 1;
      return `id-${idCounter}`;
    },
  });
}

function runtimeState(): ActiveConversationTurnDescription {
  return {
    autonomous: false,
    originMessageId: null,
  };
}

/** Host routing the CLI's alignment POSTs to the real agent handlers. */
function makeHost(
  service: SessionAlignmentService,
  files: Record<string, string>,
): CliHost {
  const agentHandlers = createSessionAlignmentAgentRouteHandlers({
    auth: createAgentAuth({ configDir: dir }),
    async resolveProjectPath(name) {
      return name === PROJECT_NAME ? PROJECT_PATH : null;
    },
    async getSession(projectPath, sessionName) {
      return projectPath === PROJECT_PATH && sessionName === SESSION
        ? { sessionName }
        : null;
    },
    describeActiveTurn: () => runtimeState(),
    beginDraft: service.beginDraft,
    fillDraft: service.fillDraft,
    proposeDecisions: service.proposeDecisions,
  });

  return {
    async fetch(url, init) {
      const parsed = new URL(url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      // api projects <name> sessions <session> alignment <charter|decisions>
      const name = decodeURIComponent(segments[2] ?? "");
      const session = decodeURIComponent(segments[4] ?? "");
      const leaf = segments[6];
      const request = new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
      });
      const params = Promise.resolve({ name, session });
      if (leaf === "charter")
        return agentHandlers.writeCharter(request, { params });
      if (leaf === "decisions") {
        return agentHandlers.proposeDecisions(request, { params });
      }
      throw new Error(`unhandled ${init.method} ${parsed.pathname}`);
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: os.platform(),
    homedir: os.homedir(),
  };
}

/** Read alignment state through the EXISTING browser GET route handler. */
async function readAlignmentState(service: SessionAlignmentService) {
  const handlers = createSessionAlignmentRouteHandlers({
    async resolveProjectPath(name) {
      return name === PROJECT_NAME ? PROJECT_PATH : null;
    },
    service,
  });
  const response = await handlers.getAlignmentState(
    new Request(
      `http://localhost/api/projects/${PROJECT_NAME}/sessions/${SESSION}/alignment`,
    ),
    { params: Promise.resolve({ name: PROJECT_NAME, session: SESSION }) },
  );
  expect(response.status).toBe(200);
  return response.json() as Promise<{
    active: { version: number | null } | null;
    draft: { content: string } | null;
    pendingProposals: { batchId: string; proposals: { statement: string }[] }[];
  }>;
}

function makeEnv(overrides: CliEnv = {}): CliEnv {
  return {
    CC_SERVER_URL: "http://127.0.0.1:4999",
    CC_API_TOKEN: TOKEN,
    CC_PROJECT: PROJECT_NAME,
    CC_SESSION: SESSION,
    CC_CONVERSATION_ID: CONVERSATION_ID,
    ...overrides,
  };
}

describe("cctl charter write against the real alignment handlers", () => {
  const CHARTER_FILE = "/tmp/charter.json";

  it("submits a draft visible as pending approval through the GET route", async () => {
    const service = buildService();
    const host = makeHost(service, {
      [CHARTER_FILE]: JSON.stringify({ content: "## Mission\nShip it." }),
    });

    const result = await runCcWithHost(
      ["charter", "write", "--file", CHARTER_FILE],
      makeEnv(),
      host,
    );
    expect(result.exitCode).toBe(0);

    const state = await readAlignmentState(service);
    expect(state.draft?.content).toBe("## Mission\nShip it.");
    // Still pending — the active charter is unchanged until a human approves.
    expect(state.active).toBeNull();
  });

  it("exits 3 through the real token gate when the token is wrong", async () => {
    const service = buildService();
    const host = makeHost(service, {
      [CHARTER_FILE]: JSON.stringify({ content: "## Mission\nShip it." }),
    });
    const result = await runCcWithHost(
      ["charter", "write", "--file", CHARTER_FILE],
      makeEnv({ CC_API_TOKEN: "wrong" }),
      host,
    );
    expect(result.exitCode).toBe(3);
    // The rejected submission left no draft behind.
    const state = await readAlignmentState(service);
    expect(state.draft).toBeNull();
  });
});

describe("cctl decisions propose against the real alignment handlers", () => {
  const DECISIONS_FILE = "/tmp/decisions.json";

  it("submits a batch visible as a pending proposal through the GET route", async () => {
    const service = buildService();
    const host = makeHost(service, {
      [DECISIONS_FILE]: JSON.stringify({
        decisions: [
          { statement: "Use SQLite", rationale: "Simplicity" },
          { statement: "No focus mode" },
        ],
      }),
    });

    const result = await runCcWithHost(
      ["decisions", "propose", "--file", DECISIONS_FILE],
      makeEnv(),
      host,
    );
    expect(result.exitCode).toBe(0);

    const state = await readAlignmentState(service);
    expect(state.pendingProposals).toHaveLength(1);
    expect(
      state.pendingProposals[0]?.proposals.map((p) => p.statement).sort(),
    ).toEqual(["No focus mode", "Use SQLite"]);
  });
});
