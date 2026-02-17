import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { existsSyncMock, readFileMock, homedirMock, readStateMock } = vi.hoisted(
  () => ({
    existsSyncMock: vi.fn(),
    readFileMock: vi.fn(),
    homedirMock: vi.fn(() => "/home/testuser"),
    readStateMock: vi.fn(),
  }),
);

vi.mock("node:fs", () => ({
  existsSync: existsSyncMock,
}));

vi.mock("node:fs/promises", () => ({
  readFile: readFileMock,
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    default: { ...actual, homedir: homedirMock },
    homedir: homedirMock,
  };
});

vi.mock("./state", () => ({
  readState: readStateMock,
  writeState: vi.fn(),
}));

import { detectHooksStatus, processHookEvent } from "./hooks";

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(false);
  readFileMock.mockRejectedValue(new Error("not found"));
  readStateMock.mockResolvedValue({ projects: {} });
});

// ===========================================================================
// 5.1 – detectHooksStatus (Req 4.1–4.5)
// ===========================================================================

describe("detectHooksStatus", () => {
  const settingsWithBothHooks = JSON.stringify({
    hooks: {
      UserPromptSubmit: [
        {
          hooks: [
            {
              type: "command",
              command:
                'cat | curl -s -X POST http://localhost:3000/api/hooks -H "Content-Type: application/json" -d @- # csm',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                'cat | curl -s -X POST http://localhost:3000/api/hooks -H "Content-Type: application/json" -d @- # csm',
            },
          ],
        },
      ],
    },
  });

  it("detects both hooks installed (Req 4.1, 4.2, 4.3, 4.4)", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(settingsWithBothHooks);

    const result = await detectHooksStatus();
    expect(result.installed).toBe(true);
    expect(result.hasUserPromptSubmit).toBe(true);
    expect(result.hasStop).toBe(true);
  });

  it("detects partial config: only UserPromptSubmit (Req 4.2, 4.4)", async () => {
    const partialSettings = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "csm-forward" }],
          },
        ],
      },
    });
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(partialSettings);

    const result = await detectHooksStatus();
    expect(result.installed).toBe(false);
    expect(result.hasUserPromptSubmit).toBe(true);
    expect(result.hasStop).toBe(false);
  });

  it("detects partial config: only Stop (Req 4.2, 4.4)", async () => {
    const partialSettings = JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [{ type: "command", command: "csm-notify" }],
          },
        ],
      },
    });
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(partialSettings);

    const result = await detectHooksStatus();
    expect(result.installed).toBe(false);
    expect(result.hasUserPromptSubmit).toBe(false);
    expect(result.hasStop).toBe(true);
  });

  it("returns all false when settings file missing (Req 4.5)", async () => {
    existsSyncMock.mockReturnValue(false);

    const result = await detectHooksStatus();
    expect(result.installed).toBe(false);
    expect(result.hasUserPromptSubmit).toBe(false);
    expect(result.hasStop).toBe(false);
  });

  it("returns all false when settings file has invalid JSON (Req 4.5)", async () => {
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue("not valid json {{{");

    const result = await detectHooksStatus();
    expect(result.installed).toBe(false);
    expect(result.hasUserPromptSubmit).toBe(false);
    expect(result.hasStop).toBe(false);
  });

  it("ignores hooks without 'csm' in command (Req 4.3)", async () => {
    const nonCsmSettings = JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [{ type: "command", command: "echo 'some other hook'" }],
          },
        ],
        Stop: [
          {
            hooks: [{ type: "command", command: "some-other-tool notify" }],
          },
        ],
      },
    });
    existsSyncMock.mockReturnValue(true);
    readFileMock.mockResolvedValue(nonCsmSettings);

    const result = await detectHooksStatus();
    expect(result.installed).toBe(false);
    expect(result.hasUserPromptSubmit).toBe(false);
    expect(result.hasStop).toBe(false);
  });
});

// ===========================================================================
// 5.3 – findSessionByCwd cross-project matching (Req 2.1, 2.4)
// ===========================================================================

describe("findSessionByCwd (via processHookEvent)", () => {
  const multiProjectState = {
    projects: {
      "/project-a": {
        rootPath: "/project-a",
        sessions: {
          "session-a": {
            sessionName: "session-a",
            worktreePath: "/project-a/.worktrees/session-a",
            branchName: "csm/session-a",
            claudeSessionId: null,
            transcriptPath: null,
            status: "ready" as const,
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            promptCount: 0,
            archived: false,
            finished: false,
            messages: [],
          },
        },
      },
      "/project-b": {
        rootPath: "/project-b",
        sessions: {
          "session-b": {
            sessionName: "session-b",
            worktreePath: "/project-b/.worktrees/session-b",
            branchName: "csm/session-b",
            claudeSessionId: null,
            transcriptPath: null,
            status: "ready" as const,
            createdAt: "2024-01-01T00:00:00Z",
            lastActivityAt: "2024-01-01T00:00:00Z",
            promptCount: 0,
            archived: false,
            finished: false,
            messages: [],
          },
        },
      },
    },
  };

  it("matches session in project-b by cwd (Req 2.1)", async () => {
    readStateMock.mockResolvedValue(
      JSON.parse(JSON.stringify(multiProjectState)),
    );
    const result = await processHookEvent({
      cwd: "/project-b/.worktrees/session-b",
      session_id: "new-id",
    });
    expect(result).toBe(true);
  });

  it("matches session in project-a by cwd (Req 2.1)", async () => {
    readStateMock.mockResolvedValue(
      JSON.parse(JSON.stringify(multiProjectState)),
    );
    const result = await processHookEvent({
      cwd: "/project-a/.worktrees/session-a",
      session_id: "new-id",
    });
    expect(result).toBe(true);
  });

  it("returns false for unmatched cwd (Req 2.4)", async () => {
    readStateMock.mockResolvedValue(
      JSON.parse(JSON.stringify(multiProjectState)),
    );
    const result = await processHookEvent({
      cwd: "/unknown/path",
      session_id: "new-id",
    });
    expect(result).toBe(false);
  });
});
