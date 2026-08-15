import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createConversationRouteHandlers,
  createConversationsListRouteHandlers,
  type ConversationRouteDeps,
  type ConversationsListRouteDeps,
} from "./lifecycle-route-handlers";
import { createProjectConversationRouteHandlers } from "@/lib/project-conversations/route-handlers";
import type { ProjectConversationRouteDeps } from "@/lib/project-conversations/route-handlers";
import { createActiveConversationsRouteHandlers } from "@/lib/active-conversations/route-handlers";
import type { ActiveConversationsRouteDeps } from "@/lib/active-conversations/route-handlers";
import { createListAllConversations } from "./cross-project-list";
import type { ListAllConversationsDeps } from "./cross-project-list";
import { createChatSpawnService } from "@/lib/chat-spawning/spawn-service";
import { redactedConversationProfile } from "./conversation-profile";
import { toPublicSessionState } from "@/lib/sessions/schemas";
import {
  sessionListItemSchema,
  sessionStateSchema,
  type SessionState,
} from "@/lib/sessions/schemas";
import { _resetLoggerForTesting } from "@/lib/logging/logger";
import { resolveConversationProfileInjection } from "@/lib/workflows/conversation/pre-turn/profile-injection";
import { redactAgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import {
  PROFILE_SECRET_SENTINEL,
  REDACTED_SNAPSHOT_FIXTURE,
  SNAPSHOT_FIXTURE,
  buildProfiledConversation,
} from "./testing/profile-snapshot-fixtures";
import type { SessionConversationListItem } from "@/lib/state-store";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { StoredConversationState } from "./schemas";

/**
 * R6.3 — the profile's instruction text never reaches a read surface.
 *
 * Every conversation these surfaces serve carries a profile whose instructions
 * embed one sentinel string, so a hit anywhere in a serialized payload is
 * unambiguously instruction leakage. Each case also asserts the REDACTED
 * identity IS present: the guarantee is redaction, not omission — a surface
 * that dropped the profile entirely would pass a leak check while failing the
 * feature.
 */

const PROJECT_PATH = "/repo";
const PROJECT_NAME = "demo";
const SESSION_NAME = "feature-x";

function ctx(params: Record<string, string>) {
  return { params: Promise.resolve(params) };
}

function getRequest(): Request {
  return new Request("http://test/", { method: "GET" });
}

function jsonRequest(body: unknown): Request {
  return new Request("http://test/", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function profiledSessionConversation(id = "conv-1"): StoredConversationState {
  return buildProfiledConversation({ id, scope: "session" });
}

function profiledProjectConversation(id = "plc-1"): StoredConversationState {
  return buildProfiledConversation({ id, scope: "project", open: true });
}

/** The slim session row the store's list projection actually returns. */
function makeSessionListItem(): SessionConversationListItem["session"] {
  return {
    ...sessionListItemSchema.parse({
      sessionName: SESSION_NAME,
      worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
      branchName: `csm/${SESSION_NAME}`,
      targetBranch: "main",
      parentSessionName: null,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      archived: false,
      finished: false,
      source: "cc",
      creationMode: "normal",
      tddEnabled: false,
      derivedStatus: "idle",
      promptCount: 0,
      derivedLastActivityAt: "2026-01-01T00:00:00Z",
      collabContribution: null,
      hasActiveGraphWorkflow: false,
    }),
    spawnedFrom: null,
    workflowEnvelopes: {},
  };
}

function makeSession(
  conversations: StoredConversationState[] = [],
): SessionState {
  return sessionStateSchema.parse({
    sessionName: SESSION_NAME,
    worktreePath: `${PROJECT_PATH}/.worktrees/${SESSION_NAME}`,
    branchName: `csm/${SESSION_NAME}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    conversations,
  });
}

/** Serialized bytes of a payload, the form a client actually receives. */
async function wire(response: Response): Promise<string> {
  return await response.text();
}

function expectNoLeak(serialized: string): void {
  expect(serialized).not.toContain(PROFILE_SECRET_SENTINEL);
  expect(serialized).not.toContain(SNAPSHOT_FIXTURE.renderedInstructionBlock);
  expect(serialized).not.toContain("renderedInstructionBlock");
  expect(serialized).not.toContain('"instructions"');
}

function expectRedactedIdentityPresent(serialized: string): void {
  expect(serialized).toContain(REDACTED_SNAPSHOT_FIXTURE.name);
  expect(serialized).toContain(REDACTED_SNAPSHOT_FIXTURE.id);
  expect(serialized).toContain(REDACTED_SNAPSHOT_FIXTURE.sourceContentHash);
  expect(serialized).toContain(
    REDACTED_SNAPSHOT_FIXTURE.resolvedInstructionHash,
  );
}

// ---------------------------------------------------------------------------
// Session conversation routes + SSE
// ---------------------------------------------------------------------------

describe("session conversation routes", () => {
  const conversation = profiledSessionConversation();

  const listDeps: ConversationsListRouteDeps = {
    resolveProjectPath: async () => PROJECT_PATH,
    getSession: async () => makeSession([conversation]),
    getSessionConversations: async () => [conversation],
  };

  function lifecycleHarness() {
    const broadcasts: SSEEvent[] = [];
    const deps: ConversationRouteDeps = {
      resolveProjectPath: async () => PROJECT_PATH,
      getProjectDisplayName: () => PROJECT_NAME,
      getSession: async () => makeSession([conversation]),
      createConversation: async () => conversation,
      deleteConversation: async () => {},
      changeConversationProfile: async () => {
        throw new Error("not exercised here");
      },
      renameConversation: async () => {},
      resolveConversationNamingContent: async () => null,
      resolveMessageNamingContent: async () => null,
      generateAndApplyConversationName: async () => null,
      setConversationArchived: async () => {},
      broadcast: (event) => {
        broadcasts.push(event);
        return { delivered: true };
      },
    };
    return { deps, broadcasts };
  }

  it("lists conversations without instruction text but with the redacted identity", async () => {
    const { GET } = createConversationsListRouteHandlers(listDeps);
    const body = await wire(
      await GET(
        getRequest(),
        ctx({ name: PROJECT_NAME, session: SESSION_NAME }),
      ),
    );

    expectNoLeak(body);
    expectRedactedIdentityPresent(body);
  });

  it("returns a created conversation redacted, and broadcasts it redacted", async () => {
    const { deps, broadcasts } = lifecycleHarness();
    const { POST_CREATE } = createConversationRouteHandlers(deps);

    const body = await wire(
      await POST_CREATE(
        jsonRequest({}),
        ctx({ name: PROJECT_NAME, session: SESSION_NAME }),
      ),
    );

    expectNoLeak(body);
    expectRedactedIdentityPresent(body);

    // The `conversation-created` frame carries a whole conversation, so it is
    // the SSE payload most able to leak.
    const created = broadcasts.find((e) => e.type === "conversation-created");
    expect(created).toBeDefined();
    const frame = JSON.stringify(created);
    expectNoLeak(frame);
    expectRedactedIdentityPresent(frame);
  });
});

// ---------------------------------------------------------------------------
// Project conversation routes + SSE
// ---------------------------------------------------------------------------

describe("project conversation routes", () => {
  const conversation = profiledProjectConversation();

  function harness() {
    const broadcasts: SSEEvent[] = [];
    const deps: ProjectConversationRouteDeps = {
      resolveProjectPath: async (name) =>
        name === PROJECT_NAME ? PROJECT_PATH : null,
      getProjectDisplayName: () => PROJECT_NAME,
      createProjectConversation: async () => conversation,
      getProjectConversation: async () => conversation,
      listProjectConversations: async () => [conversation],
      readConversationMessagesWithSeq: async () => [],
      renameProjectConversation: async () => {},
      resolveConversationNamingContent: async () => null,
      resolveMessageNamingContent: async () => null,
      generateAndApplyConversationName: async () => null,
      setProjectConversationArchived: async () => {},
      setProjectConversationOpen: async () => {},
      markProjectConversationRead: async () => {},
      executeProjectPromptStream: async () => ({ ok: true }) as never,
      isConversationBusy: () => false,
      changeConversationProfile: async () =>
        redactAgentProfileSnapshot(SNAPSHOT_FIXTURE),
      broadcast: (event) => {
        broadcasts.push(event);
        return { delivered: true };
      },
    };
    return { deps, broadcasts };
  }

  it("lists project conversations redacted", async () => {
    const { deps } = harness();
    const { listGET } = createProjectConversationRouteHandlers(deps);
    const body = await wire(
      await listGET(getRequest(), ctx({ name: PROJECT_NAME })),
    );

    expectNoLeak(body);
    expectRedactedIdentityPresent(body);
  });

  it("returns and broadcasts a created project conversation redacted", async () => {
    const { deps, broadcasts } = harness();
    const { createPOST } = createProjectConversationRouteHandlers(deps);

    const body = await wire(
      await createPOST(jsonRequest({}), ctx({ name: PROJECT_NAME })),
    );

    expectNoLeak(body);
    expectRedactedIdentityPresent(body);

    const created = broadcasts.find((e) => e.type === "conversation-created");
    expect(created).toBeDefined();
    const frame = JSON.stringify(created);
    expectNoLeak(frame);
    expectRedactedIdentityPresent(frame);
  });

  it("answers a project profile change redacted", async () => {
    const { deps } = harness();
    const { profilePATCH } = createProjectConversationRouteHandlers(deps);

    const body = await wire(
      await profilePATCH(
        jsonRequest({ profile: "project:security-reviewer" }),
        ctx({ name: PROJECT_NAME, conversationId: conversation.id }),
      ),
    );

    expectNoLeak(body);
    expectRedactedIdentityPresent(body);
  });
});

// ---------------------------------------------------------------------------
// Chat spawning (the third `conversation-created` producer)
// ---------------------------------------------------------------------------

describe("chat spawn conversation-created broadcast", () => {
  it("broadcasts the new session's conversation redacted", async () => {
    const conversation = profiledSessionConversation("spawned-conv");
    const broadcasts: SSEEvent[] = [];

    const service = createChatSpawnService({
      createSession: async () => makeSession([conversation]),
      resolveCommittedHeadBase: async () =>
        "deadbeefcafedeadbeefcafedeadbeefcafe0000",
      setSessionSpawnedFrom: async () => {},
      addPlcSpawnedSessionIds: async () => {},
      dispatchFirstTurn: async () => ({ dispatched: true }),
      broadcast: (event) => {
        broadcasts.push(event);
      },
    });

    const result = await service.createFromProposal({
      projectPath: PROJECT_PATH,
      projectName: PROJECT_NAME,
      conversationId: "origin-conv",
      proposal: {
        sessions: [
          { name: "alpha", target: "main", agent: "claude", mode: "normal" },
        ],
      },
    });

    // A conversation carrying a profile must still BE broadcast: the strict
    // public schema turns an unprojected producer into a parse failure, which
    // silently drops the frame rather than leaking it.
    expect(result.failed).toEqual([]);
    const created = broadcasts.find((e) => e.type === "conversation-created");
    expect(created).toBeDefined();
    const frame = JSON.stringify(created);
    expectNoLeak(frame);
    expectRedactedIdentityPresent(frame);
  });
});

// ---------------------------------------------------------------------------
// Session detail (the route that serializes a whole session)
// ---------------------------------------------------------------------------

describe("session detail projection", () => {
  it("redacts the profile of every conversation the session carries", () => {
    const projected = toPublicSessionState(
      makeSession([
        profiledSessionConversation("conv-1"),
        profiledSessionConversation("conv-2"),
      ]),
    );

    const serialized = JSON.stringify(projected);
    expectNoLeak(serialized);
    expectRedactedIdentityPresent(serialized);
    expect(projected.conversations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Feeds
// ---------------------------------------------------------------------------

/**
 * The store's list-item projection for a profiled conversation. Built through
 * the production redaction helper rather than a literal, so these feeds are
 * driven with exactly what the repository hands them — the redacted identity
 * and nothing else, since the list tier never pulls the snapshot blob.
 */
function profiledListItemProjection(
  id = "conv-1",
): SessionConversationListItem["conversations"][number] {
  const conversation = profiledSessionConversation(id);
  return {
    id: conversation.id,
    projectPath: PROJECT_PATH,
    sessionName: SESSION_NAME,
    name: conversation.name,
    summary: conversation.summary,
    status: conversation.status,
    role: conversation.role,
    archived: conversation.archived,
    agentBackend: conversation.agentBackend,
    backendRef: conversation.backendRef,
    transcriptPath: conversation.transcriptPath,
    lastActivityAt: conversation.lastActivityAt,
    debugMode: conversation.debugMode,
    pendingQuestionId: conversation.pendingQuestionId,
    pendingQuestions: conversation.pendingQuestions,
    forkedFrom: conversation.forkedFrom,
    unread: conversation.unread,
    redactedProfileSnapshot: redactedConversationProfile(conversation),
  };
}

describe("active conversations feed", () => {
  it("carries the redacted identity for either scope and no instruction text", async () => {
    const projectConversation = profiledProjectConversation();

    const deps: ActiveConversationsRouteDeps = {
      listSessionConversationListItems: async () => [
        {
          projectPath: PROJECT_PATH,
          session: makeSessionListItem(),
          conversations: [profiledListItemProjection()],
        },
      ],
      getArchivedProjects: async () => new Set<string>(),
      getProjectDisplayName: () => PROJECT_NAME,
      readLastAssistantContent: async () => null,
      listProjectConversations: async () => [
        { projectPath: PROJECT_PATH, conversation: projectConversation },
      ],
      listActiveGraphWorkflowExecutions: async () => new Map(),
      listActiveSpecExecutions: async () => [],
      getBackgroundActivity: () => null,
    };

    const { GET } = createActiveConversationsRouteHandlers(deps);
    const body = await wire(await GET());

    expectNoLeak(body);
    expectRedactedIdentityPresent(body);
  });
});

describe("cross-project conversation feed", () => {
  it("carries the redacted identity for either scope and no instruction text", async () => {
    const projectConversation = profiledProjectConversation();

    const deps: ListAllConversationsDeps = {
      getArchivedProjects: async () => new Set<string>(),
      listSessionConversationListItems: async () => [
        {
          projectPath: PROJECT_PATH,
          session: makeSessionListItem(),
          conversations: [profiledListItemProjection()],
        },
      ],
      listAllProjectConversations: async () => [
        { projectPath: PROJECT_PATH, conversation: projectConversation },
      ],
      getFirstPromptSnippet: async () => null,
      findArtifactsByConversationIds: () => [],
      readTranscriptEntries: async () => ({
        entries: [],
        nextSeq: 0,
        maxSeq: 0,
      }),
    };

    const result = await createListAllConversations(deps)({
      includeArchived: true,
    });

    expectNoLeak(JSON.stringify(result));
    expectRedactedIdentityPresent(JSON.stringify(result));
  });
});

// ---------------------------------------------------------------------------
// Structured logs
// ---------------------------------------------------------------------------

describe("structured log output", () => {
  const tmpDir = path.join(os.tmpdir(), "cc-profile-leak-test");
  const logFile = path.join(tmpDir, "profile.log");

  beforeEach(() => {
    rmSync(logFile, { force: true });
    _resetLoggerForTesting();
    delete process.env["CC_LOG_SILENT"];
    process.env["CC_LOG_FILE"] = logFile;
    process.env["CC_LOG_LEVEL"] = "debug";
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(logFile, { force: true });
    _resetLoggerForTesting();
    process.env["CC_LOG_SILENT"] = "1";
    delete process.env["CC_LOG_FILE"];
    delete process.env["CC_LOG_LEVEL"];
  });

  it("records the profile of a real turn without instruction text", async () => {
    // Driven through the production pre-turn step that resolves the block for
    // the runtime, so what lands in the log file is what a live turn writes —
    // not a hand-assembled call that could be safe only because the test
    // chose safe arguments.
    const conversation = profiledSessionConversation();
    const resolved = await resolveConversationProfileInjection(
      { getConversation: async () => conversation },
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: conversation.id,
      },
    );
    expect(resolved.instructionBlock).toBe(
      SNAPSHOT_FIXTURE.renderedInstructionBlock,
    );

    const written = readFileSync(logFile, "utf-8");
    expectNoLeak(written);
    expect(written).toContain("conversation.profile_injected");
    expect(written).toContain("project:security-reviewer");
    expect(written).toContain(
      REDACTED_SNAPSHOT_FIXTURE.resolvedInstructionHash,
    );
  });
});

// ---------------------------------------------------------------------------
// Library API responses — covered by the library CRUD task, not this one
// ---------------------------------------------------------------------------
//
// R6.3 is covered by TWO approved tasks. This file is the CONVERSATION half:
// every surface above serializes a conversation. The library half — "library
// API responses other than authorized get" — is covered by
// `agent-profile-library-task-api-events`, whose approved touched paths are
// `src/app/api` and `src/lib/agent-profiles` (this task's are the conversation
// domains). It owns the library's own sentinel suite, which asserts the same
// guarantee across listings, mutation responses, the change event, and logs.
// Reproducing it here would mean re-implementing the library storage, service,
// and routes that this task's scope excludes.
