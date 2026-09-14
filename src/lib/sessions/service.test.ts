import { createHostedBackendFixture } from "@/lib/workflows/conversation/testing/hosted-backend-fixture";
let hosted: ReturnType<typeof createHostedBackendFixture>;
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/logging", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logging")>();
  return { ...actual, createLogger: () => logger };
});

beforeEach(() => {
  logger.info.mockClear();
  logger.debug.mockClear();
  logger.warn.mockClear();
  logger.error.mockClear();
});

import type { GitClient } from "../git/client";
import { materializeGlobalConfig } from "@/lib/config/loader";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import type {
  AgentTaskResult,
  AgentTaskRunner,
} from "@/lib/agent-backends/task";
import { createTicketProjectOperationGate } from "../tickets/project-operation-gate";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { createSessionLifecycleGate } from "./lifecycle-gate";
import { _resetForTesting as _resetRuntimeRegistryForTesting } from "@/lib/agent-backends/runtime-registry";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import { computeContentHash } from "@/lib/agent-profiles/hashing";
import {
  validateSessionName,
  generateRandomSuffix,
  createSessionService,
  PLANNER_SESSION_NAME,
  type SessionDeps,
} from "./service";
// ---------------------------------------------------------------------------
// Test dep factory – replaces all vi.mock() calls
// ---------------------------------------------------------------------------

function createTestDeps() {
  hosted?.dispose();
  hosted = createHostedBackendFixture("/projects/repo", "to-delete");
  const lifecycleGate = createSessionLifecycleGate();
  const gitMock = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
  const readStateMock = vi.fn().mockResolvedValue(emptyState());
  const writeStateMock = vi.fn();
  const existsSyncMock = vi.fn().mockReturnValue(false);
  const execFileAsyncMock = vi
    .fn()
    .mockResolvedValue({ stdout: "", stderr: "" });
  const taskRunnerRunMock = vi.fn();
  const fakeTaskRunner: AgentTaskRunner = {
    backend: "claude",
    run: taskRunnerRunMock as AgentTaskRunner["run"],
  };
  const fastRemoveWorktreeMock = vi
    .fn()
    .mockResolvedValue({ status: "moved", trashPath: "/trash/x" });
  const sweepLaneWorktreesMock = vi.fn().mockResolvedValue([]);
  const copyAlignmentCharterFromParentMock = vi
    .fn()
    .mockResolvedValue(undefined);
  const ensureCcArtifactsExcludedMock = vi.fn().mockResolvedValue(undefined);
  const prepareManagedSkillsCheckoutMock = vi.fn().mockResolvedValue(undefined);

  const deps: SessionDeps = {
    stopConversationActor: (...args) =>
      hosted.manager.stopConversationActor(...args),
    existsSync: existsSyncMock as unknown as SessionDeps["existsSync"],
    rm: vi.fn().mockResolvedValue(undefined),
    execFileAsync: execFileAsyncMock as unknown as SessionDeps["execFileAsync"],
    gitClient: { git: gitMock } as unknown as GitClient,
    ensureCcArtifactsExcluded: ensureCcArtifactsExcludedMock,
    prepareManagedSkillsCheckout: prepareManagedSkillsCheckoutMock,
    fastRemoveWorktree:
      fastRemoveWorktreeMock as unknown as SessionDeps["fastRemoveWorktree"],
    // Focused-read fakes derive their answer from the shared fake state the
    // per-test `readStateMock.mockResolvedValue(...)` fixtures still drive, so
    // the existing fixtures need no change: `getSession` is one session slice,
    // `getProjectSessionListItems` the project's session names, and
    // `listProjectPaths` the set of known project paths.
    getSession: vi.fn(async (projectPath: string, sessionName: string) => {
      const state = await readStateMock();
      return state.projects[projectPath]?.sessions[sessionName] ?? null;
    }) as unknown as SessionDeps["getSession"],
    getProjectSessionListItems: vi.fn(async (projectPath: string) => {
      const state = await readStateMock();
      const project = state.projects[projectPath];
      if (!project) return [];
      return Object.values(
        project.sessions as Record<string, { sessionName: string }>,
      ).map((s) => ({ sessionName: s.sessionName }));
    }) as unknown as SessionDeps["getProjectSessionListItems"],
    listProjectPaths: vi.fn(async () => {
      const state = await readStateMock();
      return Object.keys(state.projects);
    }) as unknown as SessionDeps["listProjectPaths"],
    // Focused mutation fakes: each applies the real state-transition semantics
    // to the shared fake state and records via writeStateMock(state, label), so
    // the orchestration/state-outcome assertions (savedState + label) exercise
    // the service's control flow without a real store. Genuine durability is
    // proven separately against a real store in
    // state-store/focused-session-lifecycle.durability.test.ts.
    createSessionRow: vi
      .fn()
      .mockImplementation(
        async (projectPath: string, session: { sessionName: string }) => {
          const state = await readStateMock();
          state.projects[projectPath] ??= {
            rootPath: projectPath,
            sessions: {},
          };
          state.projects[projectPath].sessions[session.sessionName] = session;
          writeStateMock(state, "createSession");
        },
      ),
    deleteSessionRow: vi
      .fn()
      .mockImplementation(
        async (projectPath: string, sessionName: string, label: string) => {
          const state = await readStateMock();
          const project = state.projects[projectPath];
          if (project) delete project.sessions[sessionName];
          writeStateMock(state, label);
        },
      ),
    retargetChildrenToMain: vi
      .fn()
      .mockImplementation(
        async (projectPath: string, parentSessionName: string) => {
          const state = await readStateMock();
          const project = state.projects[projectPath];
          if (project) {
            for (const child of Object.values(project.sessions) as Array<{
              parentSessionName: string | null;
              targetBranch: string;
            }>) {
              if (child.parentSessionName === parentSessionName) {
                child.targetBranch = "main";
                child.parentSessionName = null;
              }
            }
          }
          writeStateMock(state, "retargetOrphanedChildren");
        },
      ),
    applyFusedSessionDelete: vi
      .fn()
      .mockImplementation(
        async (
          projectPath: string,
          deletedSessionNames: Iterable<string>,
          label: string,
        ) => {
          const deletedSet = new Set(deletedSessionNames);
          if (deletedSet.size === 0) return;
          const state = await readStateMock();
          const project = state.projects[projectPath];
          if (project) {
            for (const child of Object.values(project.sessions) as Array<{
              parentSessionName: string | null;
              targetBranch: string;
            }>) {
              if (
                child.parentSessionName &&
                deletedSet.has(child.parentSessionName)
              ) {
                child.targetBranch = "main";
                child.parentSessionName = null;
              }
            }
            for (const name of deletedSet) delete project.sessions[name];
          }
          writeStateMock(state, label);
        },
      ),
    deleteProjectRow: vi
      .fn()
      .mockImplementation(async (projectPath: string) => {
        const state = await readStateMock();
        delete state.projects[projectPath];
        state.archivedProjects = state.archivedProjects.filter(
          (p: string) => p !== projectPath,
        );
        state.pinnedProjects = state.pinnedProjects.filter(
          (p: string) => p !== projectPath,
        );
        writeStateMock(state, "deleteProject");
      }),
    readConfig: vi.fn().mockResolvedValue({}),
    readRepoConfig: vi.fn().mockResolvedValue(null),
    stopAllForSession: vi.fn().mockResolvedValue(undefined),
    getProjectDisplayName: vi
      .fn()
      .mockImplementation((p: string) => p.split("/").pop() ?? p),
    executeOptimisticWorkflow: vi.fn(),
    buildChildEnv: vi
      .fn()
      .mockReturnValue({}) as unknown as SessionDeps["buildChildEnv"],
    getTaskRunner: () => fakeTaskRunner,
    deleteNotificationsForSession: vi.fn().mockReturnValue(0),
    deleteJobRecordsForSession: vi.fn().mockReturnValue(0),
    deleteNotificationsForProject: vi.fn().mockReturnValue(0),
    deleteJobRecordsForProject: vi.fn().mockReturnValue(0),
    deleteContextArtifactsForScope: vi.fn().mockReturnValue(0),
    captureTicketContentForProject: vi.fn().mockResolvedValue([]),
    cleanupTicketContentForProject: vi.fn().mockResolvedValue(undefined),
    captureNotepadContentForProject: vi.fn().mockResolvedValue([]),
    cleanupNotepadContentForProject: vi.fn().mockResolvedValue(undefined),
    runSessionLifecycleOperation: (projectPath, sessionName, operation) =>
      lifecycleGate.runExclusive(projectPath, sessionName, operation),
    runSessionLifecycleOperations: (projectPath, sessionNames, operation) =>
      lifecycleGate.runExclusiveMany(projectPath, sessionNames, operation),
    runSessionProjectDeletion: (projectPath, deletion) =>
      lifecycleGate.runProjectDeletion(projectPath, deletion),
    runTicketProjectDeletion: (_projectPath, deletion) => deletion(),
    reconcileTicketSessionLifecycle: vi.fn().mockResolvedValue(undefined),
    captureTicketProjectDeletion: vi.fn().mockResolvedValue({
      projectName: "repo",
      ticketNumbers: [],
      externalNeighborTicketIds: [],
    }),
    publishTicketProjectDeletion: vi.fn(),
    sweepLaneWorktrees: sweepLaneWorktreesMock,
    copyAlignmentCharterFromParent: copyAlignmentCharterFromParentMock,
  };
  return {
    deps,
    gitMock,
    readStateMock,
    writeStateMock,
    existsSyncMock,
    execFileAsyncMock,
    fastRemoveWorktreeMock,
    sweepLaneWorktreesMock,
    taskRunnerRunMock,
    copyAlignmentCharterFromParentMock,
    ensureCcArtifactsExcludedMock,
    prepareManagedSkillsCheckoutMock,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    projects: {},
    archivedProjects: [] as string[],
    pinnedProjects: [] as string[],
  };
}

function stateWithSession(
  projectPath: string,
  sessionName: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    projects: {
      [projectPath]: {
        rootPath: projectPath,
        sessions: {
          [sessionName]: {
            sessionName,
            worktreePath: `${projectPath}/.worktrees/${sessionName}`,
            branchName: `csm/${sessionName}`,
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            archived: false,
            finished: false,
            conversations: [],
            source: "cc",
            creationMode: "normal" as const,
            tddEnabled: true,
            ...overrides,
          },
        },
      },
    },
    archivedProjects: [] as string[],
    pinnedProjects: [] as string[],
  };
}

/** AgentTaskResult with quiet defaults for the naming-task fake. */
function taskResult(overrides: Partial<AgentTaskResult> = {}): AgentTaskResult {
  return {
    backendRef: null,
    text: "Generated Name",
    usage: null,
    error: null,
    timedOut: false,
    ...overrides,
    failure:
      overrides.failure ??
      (overrides.timedOut
        ? {
            kind: "timeout",
            message: overrides.error ?? "Task timed out",
            retryable: true,
          }
        : overrides.error
          ? {
              kind: "backend_error",
              message: overrides.error,
              retryable: true,
            }
          : null),
    continuationDisposition: overrides.continuationDisposition ?? "retain",
  };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Poll a synchronous predicate until it holds, yielding to the event loop. */
async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitForCondition timed out");
    }
    await new Promise((r) => setTimeout(r, 1));
  }
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let deps: SessionDeps;
let gitMock: Mock;
let readStateMock: Mock;
let writeStateMock: Mock;
let existsSyncMock: Mock;
let execFileAsyncMock: Mock;
let fastRemoveWorktreeMock: Mock;
let sweepLaneWorktreesMock: Mock;
let taskRunnerRunMock: Mock;
let copyAlignmentCharterFromParentMock: Mock;
let ensureCcArtifactsExcludedMock: Mock;
let prepareManagedSkillsCheckoutMock: Mock;
let service: ReturnType<typeof createSessionService>;

/** Make gitMock resolve with { stdout, stderr } */
function mockGitSuccess(stdout = "", stderr = "") {
  gitMock.mockResolvedValue({ stdout, stderr });
}

function mockGitFailure(error: Error) {
  gitMock.mockRejectedValue(error);
}

/** Queue sequential resolve/reject results for successive gitMock calls */
function mockGitSequence(
  results: Array<{ error?: Error; stdout?: string; stderr?: string }>,
) {
  for (const result of results) {
    if (result.error) {
      gitMock.mockRejectedValueOnce(result.error);
    } else {
      gitMock.mockResolvedValueOnce({
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------
beforeEach(() => {
  const testSetup = createTestDeps();
  deps = testSetup.deps;
  gitMock = testSetup.gitMock;
  readStateMock = testSetup.readStateMock;
  writeStateMock = testSetup.writeStateMock;
  existsSyncMock = testSetup.existsSyncMock;
  execFileAsyncMock = testSetup.execFileAsyncMock;
  fastRemoveWorktreeMock = testSetup.fastRemoveWorktreeMock;
  sweepLaneWorktreesMock = testSetup.sweepLaneWorktreesMock;
  taskRunnerRunMock = testSetup.taskRunnerRunMock;
  copyAlignmentCharterFromParentMock =
    testSetup.copyAlignmentCharterFromParentMock;
  ensureCcArtifactsExcludedMock = testSetup.ensureCcArtifactsExcludedMock;
  prepareManagedSkillsCheckoutMock = testSetup.prepareManagedSkillsCheckoutMock;
  service = createSessionService(deps);
});

// ===========================================================================
// 1.1 – Session name validation (Req 1.1–1.5)
// ===========================================================================

describe("validateSessionName", () => {
  it("returns error for empty string", () => {
    expect(validateSessionName("")).toBe("Session name cannot be empty");
  });

  it("returns error for name over 100 characters", () => {
    const longName = "a".repeat(101);
    expect(validateSessionName(longName)).toBe(
      "Session name must be 100 characters or less",
    );
  });

  it("returns error for name with only special characters (no alphanumeric)", () => {
    expect(validateSessionName("---")).toBe(
      "Session name must contain at least one letter or number",
    );
    expect(validateSessionName("!@#$%")).toBe(
      "Session name must contain at least one letter or number",
    );
  });

  it("rejects the reserved project-conversation sentinel without echoing it", () => {
    const error = validateSessionName(PROJECT_CONVERSATION_SESSION_SENTINEL);
    expect(error).toMatch(/reserved/);
    // This message is returned verbatim in the session-creation route's public
    // JSON body, so it is a public API payload (R1.3) — it must not carry the
    // internal sentinel.
    expect(error).not.toContain(PROJECT_CONVERSATION_SESSION_SENTINEL);
    // Other underscore names remain valid.
    expect(validateSessionName("my_feature")).toBeNull();
  });

  it("returns null for exactly 100 character name", () => {
    expect(validateSessionName("a".repeat(100))).toBeNull();
  });
});

// ===========================================================================
// 1.2b – Random suffix generation
// ===========================================================================

describe("generateRandomSuffix", () => {
  it("returns only lowercase hex characters", () => {
    const result = generateRandomSuffix();
    expect(result).toMatch(/^[a-f0-9]{6}$/);
  });
});

// ===========================================================================
// 1.3 – generateSessionName
// ===========================================================================

describe("generateSessionName", () => {
  it("uses the configured naming backend even when automatic conversation naming is disabled", async () => {
    const selection = {
      modelId: "composer-2.5",
      parameters: { fast: "false" },
    };
    deps.readConfig = async () =>
      materializeGlobalConfig({
        conversationNaming: {
          enabled: false,
          backend: "cursor",
          modelSelection: selection,
          timeoutMs: 45_000,
        },
      });
    const requests: Parameters<AgentTaskRunner["run"]>[0][] = [];
    deps.getTaskRunner = (backend) => {
      if (backend !== "cursor") throw new Error(`${backend} unavailable`);
      return {
        backend,
        async run(request) {
          requests.push(request);
          return taskResult({ text: "Cursor Naming" });
        },
      };
    };
    service = createSessionService(deps);

    await expect(
      service.generateSessionName("Name through Cursor", "/projects/repo"),
    ).resolves.toBe("Cursor Naming");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      modelSelection: selection,
      timeoutMs: 45_000,
    });
  });

  it("rejects partial text from a timed-out naming task without an error string", async () => {
    taskRunnerRunMock.mockResolvedValue({
      ...taskResult({ text: "Partial Name", timedOut: true }),
      failure: null,
    });
    await expect(
      service.generateSessionName("Name this session", "/projects/repo"),
    ).rejects.toThrow("Session name generation timed out");
  });

  it("runs a naming task through the backend task runner and returns its text", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "Add Auth" }));
    const name = await service.generateSessionName(
      "Add user authentication",
      "/projects/repo",
    );
    expect(name).toBe("Add Auth");

    expect(taskRunnerRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/projects/repo",
        prompt: expect.stringContaining("Add user authentication"),
        modelSelection: { modelId: "haiku", parameters: {} },
        autonomous: true,
        timeoutMs: 60_000,
        executionProfile: "isolated-one-shot",
      }),
    );
  });

  it("takes only the first line of a multi-line answer", async () => {
    taskRunnerRunMock.mockResolvedValue(
      taskResult({ text: "  Fix Login \nExtra commentary" }),
    );
    const name = await service.generateSessionName(
      "Fix the login bug",
      "/projects/repo",
    );
    expect(name).toBe("Fix Login");
  });

  it("throws when the task runner reports an error", async () => {
    taskRunnerRunMock.mockResolvedValue(
      taskResult({ text: null, error: "SDK connection error" }),
    );
    await expect(
      service.generateSessionName("Add auth feature", "/projects/repo"),
    ).rejects.toThrow("SDK connection error");
  });

  it("throws when the task times out", async () => {
    taskRunnerRunMock.mockResolvedValue(
      taskResult({ text: null, error: "Task timed out", timedOut: true }),
    );
    await expect(
      service.generateSessionName("Add auth feature", "/projects/repo"),
    ).rejects.toThrow("Task timed out");
  });

  it("throws when the runner returns empty output", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "" }));
    await expect(
      service.generateSessionName("Implement search", "/projects/repo"),
    ).rejects.toThrow("Session name generation returned empty result");
  });

  it("throws when the runner returns a name with no alphanumeric characters", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "---!!!" }));
    await expect(
      service.generateSessionName("Bad name", "/projects/repo"),
    ).rejects.toThrow("Generated session name is invalid");
  });
});

// ===========================================================================
// 1.4 – Session creation with worktree and state persistence
// ===========================================================================

describe("createSessionNormal", () => {
  it("creates a session with user-provided name", async () => {
    mockGitSuccess(); // git worktree add
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );

    expect(session.sessionName).toBe("My Feature");
    expect(session.worktreePath).toMatch(
      /^\/projects\/repo\/\.worktrees\/my-feature-[a-f0-9]{6}$/,
    );
    expect(session.branchName).toMatch(/^csm\/my-feature-[a-f0-9]{6}$/);
    expect(session.creationMode).toBe("normal");
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]).toMatchObject({
      status: "new",
      source: "cc",
      promptCount: 0,
      name: "My Feature 1",
      role: null,
    });
    expect(session.conversations[0]!.id).toBeTruthy();
    expect(session.archived).toBe(false);
    expect(session.source).toBe("cc");
  });

  it("provisions the initial conversation on the configured defaultAgentBackend", async () => {
    deps.readConfig = vi
      .fn()
      .mockResolvedValue({ defaultAgentBackend: "codex" });
    service = createSessionService(deps);
    mockGitSuccess(); // git worktree add

    const session = await service.createSessionNormal(
      "/projects/repo",
      "Codex Default",
    );

    expect(session.conversations[0]!.agentBackend).toBe("codex");
  });

  it("provisions the initial conversation under the Standard Agent profile (R7.1)", async () => {
    mockGitSuccess(); // git worktree add

    const session = await service.createSessionNormal(
      "/projects/repo",
      "Profiled Kickoff",
    );

    // The snapshot is on the row the session is persisted with, so it is
    // durable before this session's first conversation runtime could exist.
    const snapshot = session.conversations[0]!.profileSnapshot;
    expect(snapshot).not.toBeNull();
    expect(snapshot).toMatchObject({
      tier: "builtin",
      id: STANDARD_AGENT_PROFILE_ID,
    });
    expect(computeContentHash(snapshot!.renderedInstructionBlock)).toBe(
      snapshot!.resolvedInstructionHash,
    );
    // Still changeable: nothing has been sent yet.
    expect(session.conversations[0]!.profileLockedAt).toBeNull();
  });

  it("provisions on claude when no defaultAgentBackend is configured", async () => {
    mockGitSuccess(); // git worktree add
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Default Backend",
    );
    expect(session.conversations[0]!.agentBackend).toBe("claude");
  });

  it("does not persist any session-wide objective", async () => {
    mockGitSuccess(); // git worktree add
    await service.createSessionNormal("/projects/repo", "No Objective");

    const savedState = writeStateMock.mock.calls[0]![0];
    const persisted =
      savedState.projects["/projects/repo"].sessions["No Objective"];
    expect("objective" in persisted).toBe(false);
  });

  it("does not call Claude for name generation", async () => {
    mockGitSuccess(); // git worktree add
    await service.createSessionNormal("/projects/repo", "Direct Name");

    // Only one gitMock call (git worktree add), no claude call
    expect(gitMock).toHaveBeenCalledTimes(1);
    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "add"]),
      "/projects/repo",
    );
  });

  it("sets ISO 8601 timestamps for createdAt and lastActivityAt", async () => {
    mockGitSuccess();
    const before = new Date().toISOString();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Timestamp Test",
    );
    const after = new Date().toISOString();

    expect(session.createdAt).toBeTruthy();
    expect(session.lastActivityAt).toBeTruthy();
    expect(session.createdAt).toBe(session.lastActivityAt);
    expect(new Date(session.createdAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    );
    expect(new Date(session.createdAt).getTime()).toBeLessThanOrEqual(
      new Date(after).getTime(),
    );
  });

  it("calls git worktree add with correct arguments", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Build Feature",
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "main",
      ],
      "/projects/repo",
    );
  });

  it("git-ignores the .cc/ artifact namespace for the new worktree", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Ignore CC Artifacts",
    );

    expect(ensureCcArtifactsExcludedMock).toHaveBeenCalledWith(
      session.worktreePath,
    );
  });

  it("does not fail session creation when the .cc/ exclude cannot be written", async () => {
    mockGitSuccess();
    ensureCcArtifactsExcludedMock.mockRejectedValueOnce(
      new Error("info/exclude is read-only"),
    );

    const session = await service.createSessionNormal(
      "/projects/repo",
      "Exclude Fails",
    );

    expect(session.sessionName).toBe("Exclude Fails");
  });

  it("prepares managed skills for every new checkout before returning", async () => {
    mockGitSuccess();
    const preparation = deferred();
    prepareManagedSkillsCheckoutMock.mockImplementationOnce(
      () => preparation.promise,
    );
    let creationSettled = false;

    const creation = service
      .createSessionNormal("/projects/repo", "Managed Skills Ready")
      .then((session) => {
        creationSettled = true;
        return session;
      });

    try {
      await waitForCondition(
        () => prepareManagedSkillsCheckoutMock.mock.calls.length === 1,
      );
      expect(creationSettled).toBe(false);
    } finally {
      preparation.resolve();
    }

    const session = await creation;
    expect(prepareManagedSkillsCheckoutMock).toHaveBeenCalledWith(
      session.worktreePath,
    );
  });

  it("keeps the session when managed-skill checkout preparation fails", async () => {
    mockGitSuccess();
    prepareManagedSkillsCheckoutMock.mockRejectedValueOnce(
      new Error("managed skill bridge unavailable"),
    );

    const session = await service.createSessionNormal(
      "/projects/repo",
      "Managed Skills Degraded",
    );

    expect(session.sessionName).toBe("Managed Skills Degraded");
    expect(logger.warn).toHaveBeenCalledWith(
      "session.managed_skills_checkout_prepare_failed",
      expect.objectContaining({
        projectName: "/projects/repo",
        sessionName: "Managed Skills Degraded",
        worktreePath: session.worktreePath,
        error: "managed skill bridge unavailable",
      }),
    );
    expect(gitMock).not.toHaveBeenCalledWith(
      expect.arrayContaining(["worktree", "remove"]),
      "/projects/repo",
    );
  });

  it("persists session to state via writeState", async () => {
    mockGitSuccess();
    await service.createSessionNormal("/projects/repo", "Persist Test");

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project).toBeDefined();
    expect(project.sessions["Persist Test"]).toBeDefined();
    expect(project.sessions["Persist Test"].creationMode).toBe("normal");
    expect(project.sessions["Persist Test"].conversations).toHaveLength(1);
  });

  it("auto-creates project entry when project not yet in state", async () => {
    readStateMock.mockResolvedValue(emptyState());
    mockGitSuccess();
    await service.createSessionNormal("/new/project", "First Session");

    const savedState = writeStateMock.mock.calls[0]![0];
    expect(savedState.projects["/new/project"]).toBeDefined();
    expect(savedState.projects["/new/project"].rootPath).toBe("/new/project");
  });

  it("throws for empty session name", async () => {
    await expect(
      service.createSessionNormal("/projects/repo", ""),
    ).rejects.toThrow("Session name cannot be empty");
  });

  it("accepts session names with special characters", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "test, with special chars!",
    );

    expect(session.sessionName).toBe("test, with special chars!");
    expect(session.branchName).toMatch(
      /^csm\/test-with-special-chars-[a-f0-9]{6}$/,
    );
    expect(session.worktreePath).toMatch(
      /^\/projects\/repo\/\.worktrees\/test-with-special-chars-[a-f0-9]{6}$/,
    );
  });

  it("throws for duplicate session name in same project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Existing"),
    );
    await expect(
      service.createSessionNormal("/projects/repo", "Existing"),
    ).rejects.toThrow('Session "Existing" already exists in this project');
  });

  it("allows same name in different projects", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo-a", "Shared Name"),
    );
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo-b",
      "Shared Name",
    );
    expect(session.sessionName).toBe("Shared Name");
  });

  it("throws error when worktree directory already exists", async () => {
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) return true;
      return false;
    });
    await expect(
      service.createSessionNormal("/projects/repo", "Conflict"),
    ).rejects.toThrow("Worktree directory already exists:");
  });

  // =========================================================================
  // Init script execution and rollback
  // =========================================================================

  it("executes init script with correct environment when configured", async () => {
    mockGitSuccess(); // git worktree add

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./setup.sh",
    });

    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes("setup.sh")) return true;
      return false;
    });

    const session = await service.createSessionNormal(
      "/projects/repo",
      "With Init",
    );

    // execFileAsyncMock should be called for the init script
    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const initCall = execFileAsyncMock.mock.calls[0];
    expect(initCall).toBeDefined();
    expect(initCall![0]).toBe("/projects/repo/setup.sh");
    expect(initCall![1]).toEqual([]);
    const opts = initCall![2] as {
      cwd: string;
      env: Record<string, string>;
      timeout?: number;
    };
    expect(opts.cwd).toBe(session.worktreePath);
    expect(opts.env.PROJECT_ROOT).toBe("/projects/repo");
    expect(opts.env.WORKTREE_PATH).toBe(session.worktreePath);
    // No parent session → parent worktree falls back to the project root.
    expect(opts.env.PARENT_WORKTREE_PATH).toBe("/projects/repo");
    expect(opts.env.SESSION_NAME).toBe("With Init");
    expect(opts.env.BRANCH_NAME).toBe(session.branchName);
    expect(opts.timeout).toBeUndefined();
    expect(execFileAsyncMock.mock.invocationCallOrder[0]).toBeLessThan(
      prepareManagedSkillsCheckoutMock.mock.invocationCallOrder[0]!,
    );
  });

  it("passes the parent session's worktree as PARENT_WORKTREE_PATH when branched", async () => {
    mockGitSuccess(); // git worktree add

    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Parent Session", {
        worktreePath: "/projects/repo/.worktrees/parent-session",
      }),
    );

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./setup.sh",
    });
    existsSyncMock.mockImplementation((p: string) =>
      String(p).includes("setup.sh"),
    );

    await service.provisionSession("/projects/repo", "child-session", {
      mode: "normal",
      baseBranch: "csm/parent-session",
      targetBranch: "csm/parent-session",
      parentSessionName: "Parent Session",
    });

    expect(execFileAsyncMock).toHaveBeenCalledTimes(1);
    const opts = execFileAsyncMock.mock.calls[0]![2] as {
      env: Record<string, string>;
    };
    expect(opts.env.PARENT_WORKTREE_PATH).toBe(
      "/projects/repo/.worktrees/parent-session",
    );
    expect(opts.env.PROJECT_ROOT).toBe("/projects/repo");
  });

  it("throws 'Init script not found' when script path doesn't exist", async () => {
    mockGitSuccess(); // git worktree add

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./missing.sh",
    });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true after
      }
      if (String(p).includes("missing.sh")) return false;
      return false;
    });

    await expect(
      service.createSessionNormal("/projects/repo", "Missing Script"),
    ).rejects.toThrow("Init script not found:");
  });

  it("rolls back worktree and branch on init script failure", async () => {
    const scriptError = new Error("script failed");

    mockGitSequence([
      { stdout: "" }, // git worktree add
      { stdout: "" }, // rollback: worktree remove
      { stdout: "" }, // rollback: branch delete
    ]);

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./fail.sh",
    });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    // Init script fails
    execFileAsyncMock.mockRejectedValue(scriptError);

    await expect(
      service.createSessionNormal("/projects/repo", "Fail Session"),
    ).rejects.toThrow("script failed");

    // Verify rollback: git worktree remove --force was called via gitMock
    const worktreeRemoveCall = gitMock.mock.calls[1];
    expect(worktreeRemoveCall![0]).toContain("worktree");
    expect(worktreeRemoveCall![0]).toContain("remove");
    expect(worktreeRemoveCall![0]).toContain("--force");

    // Verify rollback: git branch -D was called via gitMock
    const branchDeleteCall = gitMock.mock.calls[2];
    expect(branchDeleteCall![0]).toContain("branch");
    expect(branchDeleteCall![0]).toContain("-D");
  });

  it("falls back to filesystem rm when git worktree remove fails during rollback", async () => {
    const scriptError = new Error("script failed");
    const removeError = new Error("worktree remove failed");

    mockGitSequence([
      { stdout: "" }, // git worktree add
      { error: removeError }, // git worktree remove fails
      { stdout: "" }, // git branch -D
    ]);

    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: "./fail.sh",
    });

    let worktreeCheckCount = 0;
    existsSyncMock.mockImplementation((p: string) => {
      if (String(p).includes(".worktrees/")) {
        worktreeCheckCount++;
        return worktreeCheckCount > 1; // false first, true for cleanup
      }
      if (String(p).includes("fail.sh")) return true;
      return false;
    });

    // Init script fails
    execFileAsyncMock.mockRejectedValue(scriptError);

    await expect(
      service.createSessionNormal("/projects/repo", "Rm Fallback"),
    ).rejects.toThrow("script failed");

    expect(deps.rm).toHaveBeenCalledWith(
      expect.stringContaining(".worktrees/rm-fallback"),
      { recursive: true, force: true },
    );
  });

  it("rolls back state when creation fails after early persist", async () => {
    mockGitFailure(new Error("git worktree add failed"));

    await expect(
      service.createSessionNormal("/projects/repo", "Should Not Persist"),
    ).rejects.toThrow("git worktree add failed");

    // State is persisted first (createSession) then rolled back (rollbackSession)
    expect(writeStateMock).toHaveBeenCalledTimes(2);
    expect(writeStateMock.mock.calls[0]![1]).toBe("createSession");
    expect(writeStateMock.mock.calls[1]![1]).toBe("rollbackSession");

    // After rollback, the session should not exist in state
    const finalState = writeStateMock.mock.calls[1]![0];
    const project = finalState.projects["/projects/repo"];
    expect(project?.sessions["Should Not Persist"]).toBeUndefined();
  });
});

// ===========================================================================
// createSession — focused write + provisioning concurrency (real store)
// ===========================================================================

// These run against a real `:memory:` store (its own write queue + repos), so
// the focused insert is a genuine SQLite commit and the write queue is the real
// one. The focused insert holds the queue for O(1) in total-state, and the slow
// provisioning (git worktree add) runs entirely OUTSIDE any queue callback
// (no-slow-work-in-critical-section). Durability is asserted by repo reload.
describe("createSession — focused persistence + provisioning concurrency", () => {
  it("commits the session via the focused createSessionRow (durable) and never touches a whole-state mutateState", async () => {
    const fixture = createPersistenceFixture();
    try {
      const base = createTestDeps().deps;
      // A `mutateState` stand-in that throws if ever reached, proving
      // createSession persists through the focused `createSessionRow` and never
      // routes a write through the aggregate mutation.
      const throwingMutateState = vi
        .fn()
        .mockRejectedValue(
          new Error(
            "whole-state mutateState must not be used by createSession",
          ),
        );
      const svc = createSessionService({
        ...base,
        getSession: fixture.store.getSession,
        getProjectSessionListItems: fixture.store.getProjectSessionListItems,
        listProjectPaths: fixture.store.listProjectPaths,
        createSessionRow: fixture.store.createSessionRow,
        deleteSessionRow: fixture.store.deleteSessionRow,
        // Present only so an accidental aggregate write fails loudly;
        // createSession must never call it.
        ...({ mutateState: throwingMutateState } as Record<string, unknown>),
      });

      const created = await svc.createSessionNormal("/repo", "focused one");

      expect(throwingMutateState).not.toHaveBeenCalled();
      const reloaded = await fixture.store.getSession(
        "/repo",
        created.sessionName,
      );
      expect(reloaded).not.toBeNull();
      expect(reloaded!.conversations.length).toBeGreaterThan(0);
    } finally {
      fixture.close();
    }
  });

  it("holds no write-queue lock across slow provisioning — an unrelated queued write completes while git worktree add is in flight", async () => {
    const fixture = createPersistenceFixture();
    try {
      const base = createTestDeps().deps;
      const gitGate = deferred();
      let worktreeAddStarted = false;
      const gatedGit = vi.fn().mockImplementation((args: string[]) => {
        if (args[0] === "worktree" && args[1] === "add") {
          worktreeAddStarted = true;
          return gitGate.promise.then(() => ({ stdout: "", stderr: "" }));
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      });

      const svc = createSessionService({
        ...base,
        getSession: fixture.store.getSession,
        getProjectSessionListItems: fixture.store.getProjectSessionListItems,
        listProjectPaths: fixture.store.listProjectPaths,
        createSessionRow: fixture.store.createSessionRow,
        deleteSessionRow: fixture.store.deleteSessionRow,
        gitClient: { git: gatedGit } as unknown as GitClient,
      });

      const createPromise = svc.createSessionNormal(
        "/repo",
        "provisioning one",
      );

      // Wait until provisioning has entered the (gated) git step — the focused
      // insert has committed by now, and the write queue is released.
      await waitForCondition(() => worktreeAddStarted);
      const insertedName = (
        await fixture.store.getProjectSessions("/repo")
      ).find((s) => s.sessionName.startsWith("provisioning"));
      expect(
        insertedName,
        "focused insert committed before git resolves",
      ).toBeDefined();

      // An unrelated write on the SAME store's write queue completes while git
      // is still gated — proof the queue is not held across provisioning.
      await fixture.store.setProjectPinned("/unrelated", true);
      expect(await fixture.store.getPinnedProjects()).toContain("/unrelated");

      gitGate.resolve();
      await createPromise;
    } finally {
      fixture.close();
    }
  });
});

// ===========================================================================
// 1.5b – Random suffix in branch/worktree paths
// ===========================================================================

describe("provisionSession — random suffix", () => {
  it("branchName includes a 6-char hex suffix", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^csm\/my-feature-[a-f0-9]{6}$/);
  });

  it("git worktree add uses the suffixed branch and path", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "main",
      ],
      "/projects/repo",
    );
  });
});

// ===========================================================================
// 1.5c – Configurable branch prefix
// ===========================================================================

describe("provisionSession — configurable branch prefix", () => {
  it("uses global branchPrefix when configured", async () => {
    mockGitSuccess();
    (deps.readConfig as Mock).mockResolvedValue({ branchPrefix: "dev" });

    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^dev\/my-feature-[a-f0-9]{6}$/);
  });

  it("per-project branchPrefix overrides global", async () => {
    mockGitSuccess();
    (deps.readConfig as Mock).mockResolvedValue({ branchPrefix: "dev" });
    (deps.readRepoConfig as Mock).mockResolvedValue({
      initScriptPath: null,
      branchPrefix: "feature",
    });

    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^feature\/my-feature-[a-f0-9]{6}$/);
  });

  it("defaults to csm when no branchPrefix is configured", async () => {
    mockGitSuccess();
    (deps.readConfig as Mock).mockResolvedValue({});
    (deps.readRepoConfig as Mock).mockResolvedValue(null);

    const session = await service.createSessionNormal(
      "/projects/repo",
      "My Feature",
    );
    expect(session.branchName).toMatch(/^csm\/my-feature-[a-f0-9]{6}$/);
  });
});

// ===========================================================================
// 1.6 – Session deletion (Req 8.1–8.7)
// ===========================================================================

describe("deleteSession", () => {
  it("removes the worktree and removes session from state", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete"),
    );
    existsSyncMock.mockReturnValue(true); // worktree exists

    await service.deleteSession("/projects/repo", "to-delete");

    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/to-delete",
    });
    expect(sweepLaneWorktreesMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      sessionWorktreePath: "/projects/repo/.worktrees/to-delete",
    });
    expect(gitMock).not.toHaveBeenCalledWith(
      ["branch", "-D", "csm/to-delete"],
      "/projects/repo",
    );

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["to-delete"],
    ).toBeUndefined();
  });

  it("removes session from state even when worktree doesn't exist on disk", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "no-worktree"),
    );
    existsSyncMock.mockReturnValue(false); // worktree missing

    await service.deleteSession("/projects/repo", "no-worktree");

    // Helper should NOT be called since worktree doesn't exist
    expect(fastRemoveWorktreeMock).not.toHaveBeenCalled();

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["no-worktree"],
    ).toBeUndefined();
  });

  it("reconciles the ticket link after the session row is deleted", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "ticket-session"),
    );

    await service.deleteSession("/projects/repo", "ticket-session");

    expect(deps.reconcileTicketSessionLifecycle).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      sessionName: "ticket-session",
      endReason: "deleted",
    });
    expect(
      (deps.reconcileTicketSessionLifecycle as Mock).mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(writeStateMock.mock.invocationCallOrder[0] ?? 0);
  });

  it("still removes session from state when worktree removal fails", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "rm-fallback"),
    );
    existsSyncMock.mockReturnValue(true);
    fastRemoveWorktreeMock.mockRejectedValueOnce(
      new Error("worktree remove failed"),
    );

    await service.deleteSession("/projects/repo", "rm-fallback");

    // A failed disk cleanup must not block the fused retarget+delete
    // mutation, so the session is still removed from state.
    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["rm-fallback"],
    ).toBeUndefined();
  });

  it("throws error for non-existent project", async () => {
    readStateMock.mockResolvedValue(emptyState());
    await expect(service.deleteSession("/nonexistent", "any")).rejects.toThrow(
      "Project not found: /nonexistent",
    );
  });

  it("returns worktreeRemoved=true for CC-created sessions", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "cc-session", { source: "cc" }),
    );
    existsSyncMock.mockReturnValue(true);

    const result = await service.deleteSession("/projects/repo", "cc-session");

    expect(result.worktreeRemoved).toBe(true);
    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/cc-session",
    });
  });

  it("throws error for non-existent session in existing project", async () => {
    readStateMock.mockResolvedValue({
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: {},
        },
      },
      archivedProjects: [],
    });
    await expect(
      service.deleteSession("/projects/repo", "ghost"),
    ).rejects.toThrow('Session "ghost" not found in project');
  });

  it("purges transcript files, notifications, and job records", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete", {
        conversations: [
          {
            id: "conv-a",
            transcriptPath: "/cfg/transcripts/conv-a.jsonl",
          },
          {
            id: "conv-b",
            transcriptPath: null,
          },
          {
            id: "conv-c",
            transcriptPath: "/cfg/transcripts/conv-c.jsonl",
          },
        ],
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.deleteSession("/projects/repo", "to-delete");

    expect(deps.rm).toHaveBeenCalledWith("/cfg/transcripts/conv-a.jsonl", {
      force: true,
    });
    expect(deps.rm).toHaveBeenCalledWith("/cfg/transcripts/conv-c.jsonl", {
      force: true,
    });
    expect(deps.deleteNotificationsForSession).toHaveBeenCalledWith(
      "repo",
      "to-delete",
    );
    expect(deps.deleteJobRecordsForSession).toHaveBeenCalledWith(
      "repo",
      "to-delete",
    );
    // Context artifacts key by project PATH, not display name.
    expect(deps.deleteContextArtifactsForScope).toHaveBeenCalledWith(
      "/projects/repo",
      "to-delete",
    );
  });

  it("awaits each conversation runtime teardown before stopping dev servers or removing the worktree", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete", {
        conversations: [{ id: "conv-live", transcriptPath: null }],
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    let releaseClose: () => void = () => {};
    const teardown = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    await hosted.install("conv-live", {
      backend: "claude",
      status: "alive",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      outputFormat: undefined,

      sendTurn: async () => {
        throw new Error("sendTurn is not exercised by session deletion");
      },
      close: () => teardown,
    });

    try {
      const deletion = service.deleteSession("/projects/repo", "to-delete");
      await new Promise((resolve) => setTimeout(resolve, 0));

      // The worker still owns the worktree as its cwd until teardown resolves.
      expect(deps.stopAllForSession).not.toHaveBeenCalled();
      expect(fastRemoveWorktreeMock).not.toHaveBeenCalled();

      releaseClose();
      await deletion;

      expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
        projectPath: "/projects/repo",
        worktreePath: "/projects/repo/.worktrees/to-delete",
      });
    } finally {
      _resetRuntimeRegistryForTesting();
    }
  });

  it("preserves the session and worktree when runtime teardown rejects", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete", {
        conversations: [{ id: "conv-broken", transcriptPath: null }],
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await hosted.install("conv-broken", {
      backend: "claude",
      status: "alive",
      modelSelection: {
        modelId: "opus",
        parameters: { effort: "high" },
      },
      outputFormat: undefined,

      sendTurn: async () => {
        throw new Error("sendTurn is not exercised by session deletion");
      },
      close: () => Promise.reject(new Error("teardown failed")),
    });

    try {
      await expect(
        service.deleteSession("/projects/repo", "to-delete"),
      ).rejects.toThrow("teardown failed");
      expect(fastRemoveWorktreeMock).not.toHaveBeenCalled();
      expect(writeStateMock).not.toHaveBeenCalled();
    } finally {
      _resetRuntimeRegistryForTesting();
    }
  });

  it("does not fail when transcript file removal throws", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "to-delete", {
        conversations: [
          { id: "conv-a", transcriptPath: "/cfg/transcripts/conv-a.jsonl" },
        ],
      }),
    );
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();
    (deps.rm as Mock).mockImplementation(async (target: string) => {
      if (target.startsWith("/cfg/transcripts")) {
        throw new Error("ENOENT");
      }
    });

    await expect(
      service.deleteSession("/projects/repo", "to-delete"),
    ).resolves.toMatchObject({ worktreeRemoved: true });
    expect(deps.deleteNotificationsForSession).toHaveBeenCalled();
    expect(deps.deleteJobRecordsForSession).toHaveBeenCalled();
  });
});

describe("session incarnation lifecycle serialization", () => {
  it("preserves a recreation queued between deletion and compensation", async () => {
    const state = stateWithSession("/projects/repo", "same-name");
    readStateMock.mockImplementation(async () => state);
    const deleteEntered = deferred();
    const releaseDelete = deferred();
    (deps.stopAllForSession as Mock).mockImplementationOnce(async () => {
      deleteEntered.resolve();
      await releaseDelete.promise;
    });
    const original = state.projects["/projects/repo"]!.sessions["same-name"]!;
    const expectedCreatedAt = original.createdAt;
    const expectedWorktreePath = original.worktreePath;
    const expectedBranchName = original.branchName;

    const externalDelete = service.deleteSession("/projects/repo", "same-name");
    await deleteEntered.promise;
    const recreation = service.createSessionNormal(
      "/projects/repo",
      "same-name",
    );
    const compensation = service.deleteSessionIfCurrent(
      "/projects/repo",
      "same-name",
      {
        createdAt: expectedCreatedAt,
        worktreePath: expectedWorktreePath,
        branchName: expectedBranchName,
      },
    );

    releaseDelete.resolve();
    await externalDelete;
    const recreated = await recreation;
    await expect(compensation).resolves.toEqual({
      deleted: false,
      reason: "replaced",
    });
    expect(
      state.projects["/projects/repo"]!.sessions["same-name"]?.createdAt,
    ).toBe(recreated.createdAt);
  });

  it("skips compensation when a queued finish wins the lifecycle gate", async () => {
    const state = stateWithSession("/projects/repo", "finishing");
    readStateMock.mockImplementation(async () => state);
    const finishEntered = deferred();
    const releaseFinish = deferred();
    const original = state.projects["/projects/repo"]!.sessions.finishing!;
    const expectedCreatedAt = original.createdAt;
    const expectedWorktreePath = original.worktreePath;
    const expectedBranchName = original.branchName;

    const finish = deps.runSessionLifecycleOperation(
      "/projects/repo",
      "finishing",
      async () => {
        state.projects["/projects/repo"]!.sessions.finishing!.finished = true;
        finishEntered.resolve();
        await releaseFinish.promise;
      },
    );
    await finishEntered.promise;
    const compensation = service.deleteSessionIfCurrent(
      "/projects/repo",
      "finishing",
      {
        createdAt: expectedCreatedAt,
        worktreePath: expectedWorktreePath,
        branchName: expectedBranchName,
      },
    );

    releaseFinish.resolve();
    await finish;
    await expect(compensation).resolves.toEqual({
      deleted: false,
      reason: "finished",
    });
    expect(state.projects["/projects/repo"]!.sessions.finishing).toBeDefined();
  });

  it("lets a recreation proceed safely after compensation wins the lifecycle gate", async () => {
    const state = stateWithSession("/projects/repo", "same-name");
    readStateMock.mockImplementation(async () => state);
    const compensationEntered = deferred();
    const releaseCompensation = deferred();
    (deps.stopAllForSession as Mock).mockImplementationOnce(async () => {
      compensationEntered.resolve();
      await releaseCompensation.promise;
    });
    const original = state.projects["/projects/repo"]!.sessions["same-name"]!;
    const expectedCreatedAt = original.createdAt;
    const expectedWorktreePath = original.worktreePath;
    const expectedBranchName = original.branchName;

    const compensation = service.deleteSessionIfCurrent(
      "/projects/repo",
      "same-name",
      {
        createdAt: expectedCreatedAt,
        worktreePath: expectedWorktreePath,
        branchName: expectedBranchName,
      },
    );
    await compensationEntered.promise;
    const recreation = service.createSessionNormal(
      "/projects/repo",
      "same-name",
    );

    releaseCompensation.resolve();
    await expect(compensation).resolves.toMatchObject({ deleted: true });
    const recreated = await recreation;
    expect(
      state.projects["/projects/repo"]!.sessions["same-name"]?.createdAt,
    ).toBe(recreated.createdAt);
  });

  it("removes only the exact compensated incarnation's branch", async () => {
    const state = stateWithSession("/projects/repo", "compensated");
    readStateMock.mockImplementation(async () => state);
    existsSyncMock.mockImplementation(
      (candidate) => candidate === "/projects/repo/.worktrees/compensated",
    );
    const original = state.projects["/projects/repo"]!.sessions.compensated!;

    const result = await service.deleteSessionIfCurrent(
      "/projects/repo",
      "compensated",
      {
        createdAt: original.createdAt,
        worktreePath: original.worktreePath,
        branchName: original.branchName,
      },
    );

    expect(result).toMatchObject({ deleted: true });
    expect(gitMock).toHaveBeenCalledWith(
      ["branch", "-D", original.branchName],
      "/projects/repo",
    );
    expect(
      state.projects["/projects/repo"]!.sessions.compensated,
    ).toBeUndefined();
    const recreated = await service.createSessionNormal(
      "/projects/repo",
      "compensated",
    );
    expect(recreated.sessionName).toBe("compensated");
  });

  it("reports branch cleanup failure and retains the occupied incarnation", async () => {
    const state = stateWithSession("/projects/repo", "compensated");
    readStateMock.mockImplementation(async () => state);
    gitMock.mockRejectedValueOnce(new Error("branch is locked"));
    const original = state.projects["/projects/repo"]!.sessions.compensated!;

    await expect(
      service.deleteSessionIfCurrent("/projects/repo", "compensated", {
        createdAt: original.createdAt,
        worktreePath: original.worktreePath,
        branchName: original.branchName,
      }),
    ).rejects.toThrow("branch is locked");
    expect(
      state.projects["/projects/repo"]!.sessions.compensated,
    ).toBeDefined();
    expect(logger.error).toHaveBeenCalledWith(
      "session.compensation_branch_remove_failure",
      expect.objectContaining({
        projectPath: "/projects/repo",
        sessionName: "compensated",
        branchName: original.branchName,
        error: "branch is locked",
      }),
    );
  });
});

// ===========================================================================
// 1.6.b – Project deletion
// ===========================================================================

describe("deleteProject", () => {
  function stateWithProject(
    projectPath: string,
    sessions: Record<string, Record<string, unknown>> = {},
  ) {
    const sessionEntries: Record<string, unknown> = {};
    for (const [name, overrides] of Object.entries(sessions)) {
      sessionEntries[name] = {
        sessionName: name,
        worktreePath: `${projectPath}/.worktrees/${name}`,
        branchName: `csm/${name}`,
        createdAt: "2024-01-01T00:00:00Z",
        lastActivityAt: "2024-01-01T00:00:00Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal" as const,
        tddEnabled: true,
        ...overrides,
      };
    }
    return {
      projects: {
        [projectPath]: {
          rootPath: projectPath,
          sessions: sessionEntries,
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("removes each session, the project row, and project-level notifications/jobs", async () => {
    readStateMock.mockResolvedValue(
      stateWithProject("/projects/repo", {
        alpha: {
          conversations: [
            { id: "conv-a", transcriptPath: "/cfg/transcripts/conv-a.jsonl" },
          ],
        },
        beta: {
          conversations: [],
        },
      }),
    );
    existsSyncMock.mockReturnValue(true);

    const result = await service.deleteProject("/projects/repo");

    expect(result.sessionsRemoved).toBe(2);

    // Each session's worktree should have been routed through the fast helper
    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/alpha",
    });
    expect(fastRemoveWorktreeMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      worktreePath: "/projects/repo/.worktrees/beta",
    });

    // Transcript for alpha's conversation should be removed
    expect(deps.rm).toHaveBeenCalledWith("/cfg/transcripts/conv-a.jsonl", {
      force: true,
    });

    // Project-level bulk purge
    expect(deps.deleteNotificationsForProject).toHaveBeenCalledWith("repo");
    expect(deps.deleteJobRecordsForProject).toHaveBeenCalledWith("repo");
    expect(deps.deleteContextArtifactsForScope).toHaveBeenCalledWith(
      "/projects/repo",
    );

    // Final focused deleteProjectRow removes the project entry
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/repo"]).toBeUndefined();
  });

  it("holds the project-deletion gate across snapshot, cleanup, cascade, and events", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    const phases: string[] = [];
    deps.runTicketProjectDeletion = async (projectPath, deletion) => {
      phases.push(`gate:${projectPath}:start`);
      const result = await deletion();
      phases.push(`gate:${projectPath}:end`);
      return result;
    };
    (deps.captureTicketProjectDeletion as Mock).mockImplementation(async () => {
      phases.push("capture");
      return {
        projectName: "repo",
        ticketNumbers: [2],
        externalNeighborTicketIds: [],
      };
    });
    (deps.cleanupTicketContentForProject as Mock).mockImplementation(
      async () => {
        phases.push("cleanup");
      },
    );
    (deps.publishTicketProjectDeletion as Mock).mockImplementation(async () => {
      phases.push("publish");
    });
    service = createSessionService(deps);

    const result = await service.deleteProject("/projects/repo");

    expect(result.deletedTicketNumbers).toEqual([2]);
    expect(phases).toEqual([
      "gate:/projects/repo:start",
      "capture",
      "cleanup",
      "publish",
      "gate:/projects/repo:end",
    ]);
  });

  it("rejects session creation queued behind project deletion", async () => {
    const state = stateWithProject("/projects/repo");
    readStateMock.mockImplementation(async () => state);
    const gate = createTicketProjectOperationGate();
    deps.runTicketProjectDeletion = (projectPath, deletion) =>
      gate.runProjectDeletion(projectPath, deletion);
    const deletionEntered = deferred();
    const releaseDeletion = deferred();
    (deps.captureTicketProjectDeletion as Mock).mockImplementation(async () => {
      deletionEntered.resolve();
      await releaseDeletion.promise;
      return {
        projectName: "repo",
        ticketNumbers: [],
        externalNeighborTicketIds: [],
      };
    });
    service = createSessionService(deps);

    const deletion = service.deleteProject("/projects/repo");
    await deletionEntered.promise;
    const creation = service.createSessionNormal("/projects/repo", "too-late");
    const creationOutcome = creation.then(
      () => null,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gitMock).not.toHaveBeenCalled();

    releaseDeletion.resolve();
    await deletion;
    await expect(creationOutcome).resolves.toMatchObject({
      message: expect.stringMatching(/deleted/i),
    });
    expect(state.projects["/projects/repo"]).toBeUndefined();
    expect(gitMock).not.toHaveBeenCalled();
  });

  it("succeeds for a project with zero sessions", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/empty"));

    const result = await service.deleteProject("/projects/empty");

    expect(result.sessionsRemoved).toBe(0);
    expect(deps.deleteNotificationsForProject).toHaveBeenCalledWith("empty");
    expect(deps.deleteJobRecordsForProject).toHaveBeenCalledWith("empty");
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/empty"]).toBeUndefined();
  });

  it("throws when the project does not exist in state", async () => {
    readStateMock.mockResolvedValue(emptyState());

    await expect(service.deleteProject("/projects/ghost")).rejects.toThrow(
      "Project not found: /projects/ghost",
    );
    expect(deps.deleteNotificationsForProject).not.toHaveBeenCalled();
    expect(deps.deleteJobRecordsForProject).not.toHaveBeenCalled();
  });

  it("revalidates project existence after entering the deletion gate", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    deps.runTicketProjectDeletion = async (_projectPath, deletion) => {
      readStateMock.mockResolvedValue(emptyState());
      return deletion();
    };
    service = createSessionService(deps);

    await expect(service.deleteProject("/projects/repo")).rejects.toThrow(
      "Project not found: /projects/repo",
    );
    expect(deps.captureTicketProjectDeletion).not.toHaveBeenCalled();
    expect(deps.cleanupTicketContentForProject).not.toHaveBeenCalled();
  });

  it("captures ticket ids before the project cascade and cleans their content afterward", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    (deps.captureTicketContentForProject as Mock).mockResolvedValue([
      "ticket-a",
      "ticket-b",
    ]);

    await service.deleteProject("/projects/repo");
    const captureMock = deps.captureTicketContentForProject as Mock;
    const cleanupMock = deps.cleanupTicketContentForProject as Mock;
    expect(cleanupMock).toHaveBeenCalledWith("/projects/repo", [
      "ticket-a",
      "ticket-b",
    ]);
    const captureOrder = captureMock.mock.invocationCallOrder[0];
    const cleanupOrder = cleanupMock.mock.invocationCallOrder[0];
    const projectRowWriteOrder = writeStateMock.mock.invocationCallOrder.at(-1);
    expect(captureOrder).toBeLessThan(projectRowWriteOrder ?? 0);
    expect(cleanupOrder).toBeGreaterThan(projectRowWriteOrder ?? 0);
  });

  it("does not remove ticket content when the project cascade fails", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    (deps.captureTicketContentForProject as Mock).mockResolvedValue([
      "ticket-a",
    ]);
    (deps.deleteProjectRow as Mock).mockRejectedValueOnce(
      new Error("project cascade failed"),
    );

    await expect(service.deleteProject("/projects/repo")).rejects.toThrow(
      "project cascade failed",
    );
    expect(deps.cleanupTicketContentForProject).not.toHaveBeenCalled();
  });

  it("captures notepad ids before the project cascade and cleans their content afterward", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    (deps.captureNotepadContentForProject as Mock).mockResolvedValue([
      "notepad-a",
      "notepad-b",
    ]);

    await service.deleteProject("/projects/repo");

    const captureMock = deps.captureNotepadContentForProject as Mock;
    const cleanupMock = deps.cleanupNotepadContentForProject as Mock;
    expect(cleanupMock).toHaveBeenCalledWith("/projects/repo", [
      "notepad-a",
      "notepad-b",
    ]);
    const projectRowWriteOrder = writeStateMock.mock.invocationCallOrder.at(-1);
    expect(captureMock.mock.invocationCallOrder[0]).toBeLessThan(
      projectRowWriteOrder ?? 0,
    );
    expect(cleanupMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      projectRowWriteOrder ?? 0,
    );
  });

  it("does not remove notepad content when the project cascade fails", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    (deps.captureNotepadContentForProject as Mock).mockResolvedValue([
      "notepad-a",
    ]);
    (deps.deleteProjectRow as Mock).mockRejectedValueOnce(
      new Error("project cascade failed"),
    );

    await expect(service.deleteProject("/projects/repo")).rejects.toThrow(
      "project cascade failed",
    );
    expect(deps.cleanupNotepadContentForProject).not.toHaveBeenCalled();
  });

  it("does not fail deletion when notepad-content cleanup throws and logs a stable orphan path key", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    (deps.cleanupNotepadContentForProject as Mock).mockRejectedValue(
      new Error("notepad blob cleanup exploded"),
    );

    const result = await service.deleteProject("/projects/repo");

    expect(result.sessionsRemoved).toBe(0);
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/repo"]).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "project.delete.notepad_content_cleanup_failure",
      expect.objectContaining({
        projectPath: "/projects/repo",
        orphanPathKey: "notepad-content",
        error: "notepad blob cleanup exploded",
      }),
    );
  });

  it("still deletes the project when notepad-id capture fails", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    (deps.captureNotepadContentForProject as Mock).mockRejectedValue(
      new Error("notepad lookup failed"),
    );

    await expect(service.deleteProject("/projects/repo")).resolves.toBeTruthy();
    expect(deps.cleanupNotepadContentForProject).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "project.delete.notepad_content_capture_failure",
      expect.objectContaining({
        projectPath: "/projects/repo",
        orphanPathKey: "notepad-content",
        error: "notepad lookup failed",
      }),
    );
  });

  it("captures ticket identities before the project cascade and publishes their deletion afterward", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    const snapshot = {
      projectName: "repo",
      ticketNumbers: [3, 5],
      externalNeighborTicketIds: ["external-1", "external-2"],
    };
    (deps.captureTicketProjectDeletion as Mock).mockResolvedValue(snapshot);

    const result = await service.deleteProject("/projects/repo");

    expect(result.deletedTicketNumbers).toEqual([3, 5]);
    expect(deps.captureTicketProjectDeletion).toHaveBeenCalledWith(
      "/projects/repo",
    );
    expect(deps.deleteProjectRow).toHaveBeenCalledWith(
      "/projects/repo",
      snapshot.externalNeighborTicketIds,
      expect.any(String),
    );
    expect(deps.publishTicketProjectDeletion).toHaveBeenCalledWith(snapshot);
    const captureOrder = (deps.captureTicketProjectDeletion as Mock).mock
      .invocationCallOrder[0];
    const projectRowWriteOrder = writeStateMock.mock.invocationCallOrder.at(-1);
    const publishOrder = (deps.publishTicketProjectDeletion as Mock).mock
      .invocationCallOrder[0];
    expect(captureOrder).toBeLessThan(projectRowWriteOrder ?? 0);
    expect(publishOrder).toBeGreaterThan(projectRowWriteOrder ?? 0);
  });

  it("aborts before destructive work when ticket-number capture fails", async () => {
    readStateMock.mockResolvedValue(
      stateWithProject("/projects/repo", { alpha: {} }),
    );
    (deps.captureTicketProjectDeletion as Mock).mockRejectedValue(
      new Error("ticket lookup failed"),
    );

    await expect(service.deleteProject("/projects/repo")).rejects.toThrow(
      "ticket lookup failed",
    );
    expect(fastRemoveWorktreeMock).not.toHaveBeenCalled();
    expect(deps.deleteProjectRow).not.toHaveBeenCalled();
  });

  it("does not fail deletion when ticket-content cleanup throws and logs a stable orphan path key", async () => {
    readStateMock.mockResolvedValue(stateWithProject("/projects/repo"));
    (deps.cleanupTicketContentForProject as Mock).mockRejectedValue(
      new Error("blob cleanup exploded"),
    );

    const result = await service.deleteProject("/projects/repo");

    expect(result.sessionsRemoved).toBe(0);
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/repo"]).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "project.delete.ticket_content_cleanup_failure",
      expect.objectContaining({
        projectPath: "/projects/repo",
        orphanPathKey: "ticket-content",
        error: "blob cleanup exploded",
      }),
    );
  });

  it("continues purging when one session's worktree removal fails", async () => {
    readStateMock.mockResolvedValue(
      stateWithProject("/projects/repo", {
        alpha: { conversations: [] },
        beta: { conversations: [] },
      }),
    );
    existsSyncMock.mockReturnValue(true);
    // First removal fails; subsequent succeed. deleteProject must still
    // purge both sessions from state.
    fastRemoveWorktreeMock
      .mockRejectedValueOnce(new Error("worktree remove failed"))
      .mockResolvedValue({ status: "moved", trashPath: "/trash/x" });

    const result = await service.deleteProject("/projects/repo");

    expect(result.sessionsRemoved).toBe(2);
    expect(deps.deleteNotificationsForProject).toHaveBeenCalledWith("repo");
    const lastWriteState =
      writeStateMock.mock.calls[writeStateMock.mock.calls.length - 1]![0];
    expect(lastWriteState.projects["/projects/repo"]).toBeUndefined();
  });
});

// ===========================================================================
// 1.7 – Optimistic mode provisioning (Task 1.2)
// ===========================================================================

describe("provisionSession — optimistic mode", () => {
  it("sets conversation role to null for optimistic sessions", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "opt-null-role",
      {
        mode: "optimistic",
      },
    );

    expect(session.conversations[0]!.role).toBeNull();
  });

  it("records creationMode as optimistic in session state", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "opt-mode",
      {
        mode: "optimistic",
      },
    );

    expect(session.creationMode).toBe("optimistic");
  });
});

// ===========================================================================
// 1.8 – Optimistic session creation (Task 3.1)
// ===========================================================================

describe("createSessionOptimistic", () => {
  it("generates a session name from instructions via the backend task runner", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "Fix Login" }));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Fix the login page bug",
    );

    expect(session.sessionName).toBe("Fix Login");
    expect(taskRunnerRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ executionProfile: "isolated-one-shot" }),
    );
  });

  it("stores no session-wide objective and seeds the kickoff prompt with the instructions", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "Auth Fix" }));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Fix authentication flow",
    );

    expect(session.creationMode).toBe("optimistic");
    // The instructions no longer become a session-wide objective field.
    expect("objective" in session).toBe(false);
    const savedState = writeStateMock.mock.calls[0]![0];
    const persisted =
      savedState.projects["/projects/repo"].sessions["Auth Fix"];
    expect("objective" in persisted).toBe(false);
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]!.role).toBeNull();

    // The instructions flow to the conversation kickoff prompt path: the
    // optimistic orchestrator receives them as the first-turn prompt text.
    expect(deps.executeOptimisticWorkflow).toHaveBeenCalledWith(
      expect.objectContaining({ instructions: "Fix authentication flow" }),
    );
  });

  it("ensures generated name is unique within project", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", "Duplicate"),
    );
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "Duplicate" }));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Something duplicated",
    );

    expect(session.sessionName).toBe("Duplicate-2");
  });

  it("launches orchestrator as fire-and-forget and returns session immediately", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "Quick Task" }));
    mockGitSuccess();

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Do something quick",
    );

    // Session returned immediately
    expect(session.sessionName).toBe("Quick Task");

    // Orchestrator was launched with correct params
    expect(deps.executeOptimisticWorkflow).toHaveBeenCalledTimes(1);
    expect(deps.executeOptimisticWorkflow).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      projectName: "repo",
      session: expect.objectContaining({
        sessionName: "Quick Task",
        creationMode: "optimistic",
      }),
      instructions: "Do something quick",
    });
  });

  it("returns SessionState before orchestrator completes", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "Fast Return" }));
    mockGitSuccess();

    // Make orchestrator take a long time (simulating prompt execution)
    (deps.executeOptimisticWorkflow as Mock).mockReturnValue(
      new Promise(() => {}), // never resolves
    );

    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Long running task",
    );

    // Session returned even though orchestrator hasn't finished
    expect(session.sessionName).toBe("Fast Return");
    expect(session.creationMode).toBe("optimistic");
  });
});

// ===========================================================================
// Task 3.1 – Child session provisioning from a parent branch
// ===========================================================================

describe("provisionSession — child session branching", () => {
  it("uses baseBranch in git worktree add instead of main", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "child-session",
      {
        mode: "normal",
        baseBranch: "csm/parent-branch-abc123",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "csm/parent-branch-abc123",
      ],
      "/projects/repo",
    );
  });

  it("defaults baseBranch to main when not provided", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "regular-session",
      {
        mode: "normal",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "main",
      ],
      "/projects/repo",
    );
  });

  it("defaults targetBranch to main and parentSessionName to null", async () => {
    mockGitSuccess();
    const session = await service.provisionSession(
      "/projects/repo",
      "default-session",
      {
        mode: "normal",
      },
    );

    expect(session.targetBranch).toBe("main");
    expect(session.parentSessionName).toBeNull();
  });

  it("persists targetBranch and parentSessionName in state", async () => {
    mockGitSuccess();
    await service.provisionSession("/projects/repo", "persisted-child", {
      mode: "normal",
      targetBranch: "csm/parent-abc",
      parentSessionName: "Parent",
    });

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const session =
      savedState.projects["/projects/repo"].sessions["persisted-child"];
    expect(session.targetBranch).toBe("csm/parent-abc");
    expect(session.parentSessionName).toBe("Parent");
  });
});

// ===========================================================================
// Alignment charter copy on fork (normal mode + parent)
// ===========================================================================

describe("provisionSession — alignment charter copy on fork", () => {
  it("copies the parent's alignment charter when branched from a parent in normal mode", async () => {
    mockGitSuccess();
    await service.provisionSession("/projects/repo", "child-session", {
      mode: "normal",
      parentSessionName: "Parent Session",
    });

    expect(copyAlignmentCharterFromParentMock).toHaveBeenCalledTimes(1);
    expect(copyAlignmentCharterFromParentMock).toHaveBeenCalledWith({
      projectPath: "/projects/repo",
      sourceSessionName: "Parent Session",
      targetSessionName: "child-session",
    });
  });

  it("does not copy a charter when there is no parent session", async () => {
    mockGitSuccess();
    await service.provisionSession("/projects/repo", "lonely-session", {
      mode: "normal",
    });

    expect(copyAlignmentCharterFromParentMock).not.toHaveBeenCalled();
  });

  it("does not copy a charter for an optimistic fork", async () => {
    mockGitSuccess();
    await service.provisionSession("/projects/repo", "optimistic-child", {
      mode: "optimistic",
      parentSessionName: "Parent Session",
    });

    expect(copyAlignmentCharterFromParentMock).not.toHaveBeenCalled();
  });

  it("does not fail session creation when the charter copy throws (best-effort)", async () => {
    mockGitSuccess();
    copyAlignmentCharterFromParentMock.mockRejectedValueOnce(
      new Error("alignment service unavailable"),
    );

    const session = await service.provisionSession(
      "/projects/repo",
      "resilient-child",
      {
        mode: "normal",
        parentSessionName: "Parent Session",
      },
    );

    expect(session.sessionName).toBe("resilient-child");
    expect(copyAlignmentCharterFromParentMock).toHaveBeenCalledTimes(1);
    // The session was still persisted despite the copy failure.
    const savedState = writeStateMock.mock.calls[0]![0];
    expect(
      savedState.projects["/projects/repo"].sessions["resilient-child"],
    ).toBeDefined();
  });
});

// ===========================================================================
// Task 3.1 – Threading branching opts through creation modes
// ===========================================================================

describe("createSessionNormal — branching opts", () => {
  it("threads baseBranch, targetBranch, parentSessionName to provisionSession", async () => {
    mockGitSuccess();
    const session = await service.createSessionNormal(
      "/projects/repo",
      "Child Normal",
      undefined,
      {
        baseBranch: "csm/parent-abc",
        targetBranch: "csm/parent-abc",
        parentSessionName: "Parent",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(["csm/parent-abc"]),
      "/projects/repo",
    );
    expect(session.targetBranch).toBe("csm/parent-abc");
    expect(session.parentSessionName).toBe("Parent");
  });
});

describe("createSessionOptimistic — branching opts", () => {
  it("threads baseBranch, targetBranch, parentSessionName to provisionSession", async () => {
    taskRunnerRunMock.mockResolvedValue(taskResult({ text: "Child Opt" }));
    mockGitSuccess();
    const session = await service.createSessionOptimistic(
      "/projects/repo",
      "Build child optimistic",
      undefined,
      undefined,
      {
        baseBranch: "csm/parent-abc",
        targetBranch: "csm/parent-abc",
        parentSessionName: "Parent",
      },
    );

    expect(gitMock).toHaveBeenCalledWith(
      expect.arrayContaining(["csm/parent-abc"]),
      "/projects/repo",
    );
    expect(session.targetBranch).toBe("csm/parent-abc");
    expect(session.parentSessionName).toBe("Parent");
  });
});

// ===========================================================================
// Task 3.2 – retargetOrphanedChildren
// ===========================================================================

describe("retargetOrphanedChildren", () => {
  function stateWithChildren(
    parentName: string,
    children: Array<{
      name: string;
      targetBranch: string;
      parentSessionName: string | null;
    }>,
  ) {
    const sessions: Record<string, Record<string, unknown>> = {
      [parentName]: {
        sessionName: parentName,
        worktreePath: `/projects/repo/.worktrees/${parentName}`,
        branchName: `csm/${parentName}`,
        createdAt: "2024-01-01T00:00:00Z",
        lastActivityAt: "2024-01-01T00:00:00Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal",
        tddEnabled: true,
        targetBranch: "main",
        parentSessionName: null,
      },
    };
    for (const child of children) {
      sessions[child.name] = {
        sessionName: child.name,
        worktreePath: `/projects/repo/.worktrees/${child.name}`,
        branchName: `csm/${child.name}`,
        createdAt: "2024-01-01T00:00:00Z",
        lastActivityAt: "2024-01-01T00:00:00Z",
        archived: false,
        finished: false,
        conversations: [],
        source: "cc",
        creationMode: "normal",
        tddEnabled: true,
        targetBranch: child.targetBranch,
        parentSessionName: child.parentSessionName,
      };
    }
    return {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions,
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("resets direct children targetBranch to main and parentSessionName to null", async () => {
    const state = stateWithChildren("Parent", [
      {
        name: "Child1",
        targetBranch: "csm/Parent",
        parentSessionName: "Parent",
      },
      {
        name: "Child2",
        targetBranch: "csm/Parent",
        parentSessionName: "Parent",
      },
    ]);
    readStateMock.mockResolvedValue(state);

    await service.retargetOrphanedChildren("/projects/repo", "Parent");

    expect(writeStateMock).toHaveBeenCalled();
    const savedState = writeStateMock.mock.calls[0]![0];
    const child1 = savedState.projects["/projects/repo"].sessions["Child1"];
    const child2 = savedState.projects["/projects/repo"].sessions["Child2"];
    expect(child1.targetBranch).toBe("main");
    expect(child1.parentSessionName).toBeNull();
    expect(child2.targetBranch).toBe("main");
    expect(child2.parentSessionName).toBeNull();
  });

  it("does not cascade to transitive descendants (grandchildren)", async () => {
    const state = stateWithChildren("Parent", [
      {
        name: "Child",
        targetBranch: "csm/Parent",
        parentSessionName: "Parent",
      },
      {
        name: "Grandchild",
        targetBranch: "csm/Child",
        parentSessionName: "Child",
      },
    ]);
    readStateMock.mockResolvedValue(state);

    await service.retargetOrphanedChildren("/projects/repo", "Parent");

    const savedState = writeStateMock.mock.calls[0]![0];
    const grandchild =
      savedState.projects["/projects/repo"].sessions["Grandchild"];
    // Grandchild still points to Child — not retargeted
    expect(grandchild.targetBranch).toBe("csm/Child");
    expect(grandchild.parentSessionName).toBe("Child");
  });
});

// ===========================================================================
// deleteSession – fused retarget + remove (single focused delete)
// ===========================================================================

describe("deleteSession — orphan retargeting", () => {
  function stateWithParentAndChild() {
    return {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: {
            Parent: {
              sessionName: "Parent",
              worktreePath: "/projects/repo/.worktrees/parent",
              branchName: "csm/parent",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            Child: {
              sessionName: "Child",
              worktreePath: "/projects/repo/.worktrees/child",
              branchName: "csm/child",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "csm/parent",
              parentSessionName: "Parent",
            },
          },
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("the single deleteSession mutator retargets children and removes the parent in one pass", async () => {
    readStateMock.mockResolvedValue(stateWithParentAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.deleteSession("/projects/repo", "Parent");

    const writeCalls = writeStateMock.mock.calls;
    expect(writeCalls).toHaveLength(1);
    const [savedState, label] = writeCalls[0]!;
    expect(label).toBe("deleteSession");

    const project = savedState.projects["/projects/repo"];
    expect(project.sessions["Parent"]).toBeUndefined();
    const child = project.sessions["Child"];
    expect(child.targetBranch).toBe("main");
    expect(child.parentSessionName).toBeNull();
  });
});

// ===========================================================================
// bulkDeleteSessions – one focused fused delete for N sessions
// ===========================================================================

describe("bulkDeleteSessions", () => {
  function stateWithThreeSiblingsAndChild() {
    return {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: {
            A: {
              sessionName: "A",
              worktreePath: "/projects/repo/.worktrees/A",
              branchName: "csm/A",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            B: {
              sessionName: "B",
              worktreePath: "/projects/repo/.worktrees/B",
              branchName: "csm/B",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            C: {
              sessionName: "C",
              worktreePath: "/projects/repo/.worktrees/C",
              branchName: "csm/C",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "main",
              parentSessionName: null,
            },
            ChildOfA: {
              sessionName: "ChildOfA",
              worktreePath: "/projects/repo/.worktrees/ChildOfA",
              branchName: "csm/ChildOfA",
              createdAt: "2024-01-01T00:00:00Z",
              lastActivityAt: "2024-01-01T00:00:00Z",
              archived: false,
              finished: false,
              conversations: [],
              source: "cc",
              creationMode: "normal",
              tddEnabled: true,
              targetBranch: "csm/A",
              parentSessionName: "A",
            },
          },
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("performs the entire batch's state change in a single fused delete labeled bulkDeleteSessions", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.bulkDeleteSessions("/projects/repo", ["A", "B", "C"]);

    const fusedLabels = (deps.applyFusedSessionDelete as Mock).mock.calls.map(
      (call: unknown[]) => call[2],
    );
    expect(fusedLabels).toEqual(["bulkDeleteSessions"]);
  });

  /** A project whose only sessions are the named parentless siblings. */
  function stateWithSiblings(names: string[]) {
    return {
      projects: {
        "/projects/repo": {
          rootPath: "/projects/repo",
          sessions: Object.fromEntries(
            names.map((sessionName) => [
              sessionName,
              {
                sessionName,
                worktreePath: `/projects/repo/.worktrees/${sessionName}`,
                branchName: `csm/${sessionName}`,
                createdAt: "2024-01-01T00:00:00Z",
                lastActivityAt: "2024-01-01T00:00:00Z",
                archived: false,
                finished: false,
                conversations: [],
                source: "cc",
                creationMode: "normal",
                tddEnabled: true,
                targetBranch: "main",
                parentSessionName: null,
              },
            ]),
          ),
        },
      },
      archivedProjects: [] as string[],
      pinnedProjects: [] as string[],
    };
  }

  it("splits a large batch's state change into bounded fused-delete slices", async () => {
    const names = Array.from({ length: 25 }, (_, index) => `S${index + 1}`);
    readStateMock.mockResolvedValue(stateWithSiblings(names));
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.bulkDeleteSessions("/projects/repo", names);

    const slices = (deps.applyFusedSessionDelete as Mock).mock.calls.map(
      (call: unknown[]) => [...(call[1] as Iterable<string>)],
    );
    expect(slices.map((slice) => slice.length)).toEqual([10, 10, 5]);
    expect(slices.flat()).toEqual(names);
  });

  it("removes all sessions and retargets orphaned children in one pass", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    await service.bulkDeleteSessions("/projects/repo", ["A", "B", "C"]);

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project.sessions["A"]).toBeUndefined();
    expect(project.sessions["B"]).toBeUndefined();
    expect(project.sessions["C"]).toBeUndefined();

    const child = project.sessions["ChildOfA"];
    expect(child.targetBranch).toBe("main");
    expect(child.parentSessionName).toBeNull();
  });

  it("reconciles ticket links for every session removed by the batch", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());

    await service.bulkDeleteSessions("/projects/repo", ["A", "C"]);

    expect(deps.reconcileTicketSessionLifecycle).toHaveBeenCalledTimes(2);
    expect(deps.reconcileTicketSessionLifecycle).toHaveBeenNthCalledWith(1, {
      projectPath: "/projects/repo",
      sessionName: "A",
      endReason: "deleted",
    });
    expect(deps.reconcileTicketSessionLifecycle).toHaveBeenNthCalledWith(2, {
      projectPath: "/projects/repo",
      sessionName: "C",
      endReason: "deleted",
    });
  });

  it("a worktree-cleanup failure is non-fatal and does not abort the batch", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    // Worktree cleanup throws for B; A and C clean up fine. A failed disk
    // cleanup must not block deletion, so B is still removed from state.
    fastRemoveWorktreeMock.mockImplementation(
      async ({ worktreePath }: { worktreePath: string }) => {
        if (worktreePath === "/projects/repo/.worktrees/B") {
          throw new Error("worktree busy");
        }
        return { status: "moved", trashPath: "/trash/x" };
      },
    );

    const results = await service.bulkDeleteSessions("/projects/repo", [
      "A",
      "B",
      "C",
    ]);

    expect(results).toEqual([
      { sessionName: "A", success: true },
      { sessionName: "B", success: true },
      { sessionName: "C", success: true },
    ]);

    expect(writeStateMock).toHaveBeenCalledTimes(1);
    const savedState = writeStateMock.mock.calls[0]![0];
    const project = savedState.projects["/projects/repo"];
    expect(project.sessions["A"]).toBeUndefined();
    expect(project.sessions["B"]).toBeUndefined();
    expect(project.sessions["C"]).toBeUndefined();
  });

  it("reports session-not-found as a failure result and still processes the rest", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);
    mockGitSuccess();

    const results = await service.bulkDeleteSessions("/projects/repo", [
      "A",
      "GhostSession",
      "C",
    ]);

    expect(results[0]).toEqual({ sessionName: "A", success: true });
    expect(results[1]?.sessionName).toBe("GhostSession");
    expect(results[1]?.success).toBe(false);
    expect(results[1]?.error).toMatch(/not found/);
    expect(results[2]).toEqual({ sessionName: "C", success: true });
  });

  it("throws when the project does not exist", async () => {
    readStateMock.mockResolvedValue(emptyState());
    await expect(
      service.bulkDeleteSessions("/nonexistent", ["A"]),
    ).rejects.toThrow("Project not found: /nonexistent");
  });

  it("skips the state mutation entirely when no sessions were successfully prepared", async () => {
    readStateMock.mockResolvedValue(stateWithThreeSiblingsAndChild());
    existsSyncMock.mockReturnValue(true);

    const results = await service.bulkDeleteSessions("/projects/repo", [
      "Ghost1",
      "Ghost2",
    ]);

    expect(results.every((r) => !r.success)).toBe(true);
    expect(writeStateMock).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Reserved planner session — lazily created per project
// ===========================================================================

describe("ensurePlannerSession", () => {
  it("creates a __planner__ session with a deterministic worktree on first call", async () => {
    mockGitSuccess();

    const session = await service.ensurePlannerSession("/projects/repo");

    expect(session.sessionName).toBe(PLANNER_SESSION_NAME);
    expect(session.worktreePath).toBe(
      `/projects/repo/.worktrees/${PLANNER_SESSION_NAME}`,
    );
    expect(session.branchName).toBe(`csm/${PLANNER_SESSION_NAME}`);
    expect(session.conversations).toHaveLength(1);
    expect(session.conversations[0]!.id).toBeTruthy();

    // The worktree was provisioned via git (deterministic path, no random suffix).
    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        `csm/${PLANNER_SESSION_NAME}`,
        `/projects/repo/.worktrees/${PLANNER_SESSION_NAME}`,
        "main",
      ],
      "/projects/repo",
    );
  });

  it("returns the existing __planner__ session without provisioning again", async () => {
    readStateMock.mockResolvedValue(
      stateWithSession("/projects/repo", PLANNER_SESSION_NAME, {
        worktreePath: `/projects/repo/.worktrees/${PLANNER_SESSION_NAME}`,
        branchName: `csm/${PLANNER_SESSION_NAME}`,
        conversations: [
          {
            id: "planner-conv-1",
            name: `${PLANNER_SESSION_NAME} 1`,
            status: "idle",
            promptCount: 0,
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            source: "cc",
            summary: null,
            archived: false,
            totalCostUsd: null,
            totalDurationMs: null,
            totalTurns: null,
            transcriptPath: null,
            pendingQuestionId: null,
            pendingQuestions: null,
            pendingPromptText: null,
            forkedFrom: null,
            role: null,
            contextTokens: null,
            contextWindowMax: null,
            debugMode: null,
            machineSnapshot: null,
            agentBackend: "claude",
            backendRef: null,
          },
        ],
      }),
    );

    const session = await service.ensurePlannerSession("/projects/repo");

    expect(session.sessionName).toBe(PLANNER_SESSION_NAME);
    expect(session.conversations[0]?.id).toBe("planner-conv-1");
    expect(gitMock).not.toHaveBeenCalled();
    expect(writeStateMock).not.toHaveBeenCalled();
  });

  it("serializes concurrent ensures and returns the one planner incarnation", async () => {
    const state = emptyState();
    readStateMock.mockImplementation(async () => state);
    const firstProvisionEntered = deferred();
    const releaseFirstProvision = deferred();
    (deps.readConfig as Mock).mockImplementationOnce(async () => {
      firstProvisionEntered.resolve();
      await releaseFirstProvision.promise;
      return {};
    });

    const first = service.ensurePlannerSession("/projects/repo");
    await firstProvisionEntered.promise;
    const second = service.ensurePlannerSession("/projects/repo");
    await Promise.resolve();
    releaseFirstProvision.resolve();

    const [a, b] = await Promise.all([first, second]);
    expect(a.createdAt).toBe(b.createdAt);
    expect(a.worktreePath).toBe(b.worktreePath);
    expect(gitMock).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// createSpawnedSession (chat-spawning creation path) — derives the branch from
// the name (slug + prefix + uniqueness suffix) exactly like the New Session
// dialog, reuses provisionSession, validates the name, and never auto-runs.
// ===========================================================================
describe("createSpawnedSession", () => {
  it("derives the branch from the name (prefix + slug + suffix), not an agent-supplied branch", async () => {
    mockGitSuccess(); // git worktree add
    const session = await service.createSpawnedSession("/projects/repo", {
      name: "Login form",
      targetBranch: "main",
      mode: "normal",
      baseBranch: "HEADSHA",
    });

    // Empty global config + null repo config → the default "csm" prefix; the
    // slug comes from the name and the 6-hex suffix guarantees uniqueness.
    expect(session.branchName).toMatch(/^csm\/login-form-[0-9a-f]{6}$/);
    expect(session.sessionName).toBe("Login form");
    expect(session.creationMode).toBe("normal");
    // git worktree add -b <derived branch> <worktree> <committed-HEAD base>
    expect(gitMock).toHaveBeenCalledWith(
      [
        "worktree",
        "add",
        "-b",
        session.branchName,
        session.worktreePath,
        "HEADSHA",
      ],
      "/projects/repo",
    );
  });

  it("never fires the optimistic auto-run workflow, even for optimistic mode", async () => {
    mockGitSuccess();
    await service.createSpawnedSession("/projects/repo", {
      name: "Auto task",
      targetBranch: "main",
      mode: "optimistic",
      baseBranch: "HEADSHA",
    });
    expect(deps.executeOptimisticWorkflow).not.toHaveBeenCalled();
  });

  it("rejects an invalid session name", async () => {
    await expect(
      service.createSpawnedSession("/projects/repo", {
        name: "",
        targetBranch: "main",
        mode: "normal",
        baseBranch: "HEADSHA",
      }),
    ).rejects.toThrow("Session name cannot be empty");
    expect(gitMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate session name in the same project", async () => {
    readStateMock.mockResolvedValue(stateWithSession("/projects/repo", "dup"));
    await expect(
      service.createSpawnedSession("/projects/repo", {
        name: "dup",
        targetBranch: "main",
        mode: "normal",
        baseBranch: "HEADSHA",
      }),
    ).rejects.toThrow('Session "dup" already exists');
    expect(gitMock).not.toHaveBeenCalled();
  });

  it("propagates a worktree-add failure (e.g. duplicate/invalid branch) so the batch can record it", async () => {
    mockGitFailure(
      new Error("fatal: a branch named 'csm/login-form' already exists"),
    );
    await expect(
      service.createSpawnedSession("/projects/repo", {
        name: "Login form",
        targetBranch: "main",
        mode: "normal",
        baseBranch: "HEADSHA",
      }),
    ).rejects.toThrow("already exists");
  });
});
