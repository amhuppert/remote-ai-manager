import { describe, expect, it } from "vitest";
import { evaluateMergeInitiation } from "./initiation";

describe("a session one of whose runs is not finished", () => {
  it("refuses the merge, naming the run and how to clear it", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readCurrentRuns: (projectPath, sessionName) =>
        projectPath === "/project" && sessionName === "session"
          ? [{ runId: "run-1", sessionName: "session", progress: "paused" }]
          : [],
      readBackgroundWork: () => [],
    });

    expect(result).toMatchObject({
      admitted: false,
      refusal: { code: "RUN_CURRENT", runId: "run-1", progress: "paused" },
    });
    if (result.admitted) return;
    expect(result.refusal.message).toContain("run-1");
  });

  it("admits the merge once every run of the session has finished", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readCurrentRuns: () => [],
      readBackgroundWork: () => [],
    });

    expect(result).toEqual({ admitted: true });
  });
});

describe("a session one of whose conversations keeps background work running (design C5b §5)", () => {
  it("refuses the merge, naming the conversation and saying to stop it or wait", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readCurrentRuns: () => [],
      readBackgroundWork: (projectPath, sessionName) =>
        projectPath === "/project" && sessionName === "session"
          ? [
              {
                conversationId: "conv-1",
                conversationName: "Suite runner",
                unconfirmed: null,
              },
              {
                conversationId: "conv-2",
                conversationName: null,
                unconfirmed: null,
              },
            ]
          : [],
    });

    expect(result).toMatchObject({
      admitted: false,
      refusal: { code: "BACKGROUND_WORK_RUNNING", conversationId: "conv-1" },
    });
    if (result.admitted) return;
    expect(result.refusal.message).toContain('conversation "Suite runner"');
    expect(result.refusal.message).toContain("1 other conversation");
    expect(result.refusal.message).toMatch(/stop it .* or wait/i);
  });

  it("names a conversation without a name by its id", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-command",
      readCurrentRuns: () => [],
      readBackgroundWork: () => [
        { conversationId: "conv-2", conversationName: null, unconfirmed: null },
      ],
    });

    if (result.admitted) throw new Error("admitted");
    expect(result.refusal.message).toContain("conversation conv-2");
  });
});

describe("a session whose conversation's background work could not be confirmed stopped (design C5b §5)", () => {
  it("refuses the merge, saying the processes are unconfirmed and how to collect them", async () => {
    const result = await evaluateMergeInitiation({
      projectPath: "/project",
      sessionName: "session",
      surface: "merge-route",
      readCurrentRuns: () => [],
      readBackgroundWork: () => [
        {
          conversationId: "conv-1",
          conversationName: "Suite runner",
          unconfirmed: "the CLI did not exit",
        },
      ],
    });

    if (result.admitted) throw new Error("admitted");
    expect(result.refusal).toMatchObject({
      code: "BACKGROUND_WORK_RUNNING",
      conversationId: "conv-1",
    });
    expect(result.refusal.message).toContain("could not be confirmed stopped");
    expect(result.refusal.message).toContain("the CLI did not exit");
    expect(result.refusal.message).toMatch(/restart the server/i);
  });
});
