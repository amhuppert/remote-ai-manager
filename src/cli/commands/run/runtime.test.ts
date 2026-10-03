import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const identityEnv = { CC_CONVERSATION: "owner-1" };

const view = {
  runId: "run-1",
  title: "Fix the notice",
  kind: "agent",
  progress: { kind: "needs_owner", reasons: ["agent: halted (turn_failed)"] },
  revision: 4,
  ownerConversationId: "owner-1",
  createdAt: "2026-10-03T10:00:00.000Z",
  updatedAt: "2026-10-03T10:05:00.000Z",
  contexts: [
    {
      key: "agent",
      contextId: "run-1.agent",
      progress: { kind: "halted", halt: "turn_failed", detail: "provider error" },
      occurrence: "occ-7",
      tasks: [{ id: "t1", title: "Route", status: "open" }],
      seats: { implementer: "conv-9" },
      openQuestions: [{ questionId: "q-1", seat: "implementer", text: "Which file?" }],
      lastSummary: null,
      output: null,
    },
  ],
  boundaries: [
    { seq: 1, kind: "halted", summary: "Fix the notice: halted (turn_failed).", recordedAt: "2026-10-03T10:05:00.000Z", notified: true },
  ],
  stalled: [],
};

function bodyOf(init: { body?: unknown }): unknown {
  return typeof init.body === "string" ? JSON.parse(init.body) : undefined;
}

describe("run commands", () => {
  it("launches from a brief as the calling conversation and points at run show", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      files: { "/run.json": JSON.stringify({ brief: "Fix the duplicate notice" }) },
      respond: () => jsonReply({ runId: "run-1", contextIds: ["run-1.agent"], progress: { kind: "running" } }, 202),
    });
    const result = await fixture.run(["run", "launch", "--file", "/run.json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    const request = fixture.requests[0];
    expect(request?.url).toBe("http://cc.test/api/projects/project-one/sessions/session-one/runs");
    expect(bodyOf(request?.init ?? {})).toEqual({ brief: "Fix the duplicate notice" });
    const headers = (request?.init.headers ?? {}) as Record<string, string>;
    expect(JSON.parse(headers["x-cc-conversation-identity"] ?? "{}")).toEqual({
      sessionName: "session-one",
      conversationId: "owner-1",
    });
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({ effect: "applied", payload: { data: { runId: "run-1" } } });
    expect(output.hint).toContain("cctl run show -- run-1");
  });

  it("refuses an unknown launch option before sending anything", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      files: { "/run.json": JSON.stringify({ brief: "x", isolation: "worktree" }) },
      respond: () => jsonReply({}),
    });
    const result = await fixture.run(["run", "launch", "--file", "/run.json"]);

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toEqual([]);
  });

  it("shows halts with their occurrence, open questions and tasks", async () => {
    const fixture = createCcRuntimeFixture({ env: identityEnv, respond: () => jsonReply(view) });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("needs you: agent: halted (turn_failed)");
    expect(result.stdout).toContain("turn_failed: provider error; occurrence occ-7");
    expect(result.stdout).toContain("question q-1 from implementer: Which file?");
    expect(result.stdout).toContain("task t1 open: Route");
  });

  it("answers a question and resumes past a halt with a disposition naming its occurrence", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: ({ url }) =>
        jsonReply(url.endsWith("/answer") ? { ok: true } : { ok: true, progress: { kind: "running" } }),
    });
    expect((await fixture.run(["run", "answer", "run-1", "--question", "q-1", "--text", "notice.ts"])).exitCode).toBe(0);
    expect(
      (
        await fixture.run([
          "run",
          "resume",
          "run-1",
          "--context",
          "run-1.agent",
          "--occurrence",
          "occ-7",
          "--disposition",
          "continue",
        ])
      ).exitCode,
    ).toBe(0);

    expect(fixture.requests.map((r) => [r.url, bodyOf(r.init)])).toEqual([
      ["http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/answer", { questionId: "q-1", text: "notice.ts" }],
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/control",
        {
          action: "resume",
          dispositions: [{ contextId: "run-1.agent", occurrence: "occ-7", disposition: { kind: "continue" } }],
        },
      ],
    ]);
  });

  it("refuses incomplete dispositions without sending them", async () => {
    const fixture = createCcRuntimeFixture({ env: identityEnv, respond: () => jsonReply({ ok: true }) });
    const partial = await fixture.run(["run", "resume", "run-1", "--disposition", "continue"]);
    const grant = await fixture.run([
      "run",
      "resume",
      "run-1",
      "--context",
      "run-1.agent",
      "--occurrence",
      "occ-7",
      "--disposition",
      "grant",
    ]);
    const confirm = await fixture.run([
      "run",
      "resume",
      "run-1",
      "--context",
      "run-1.agent",
      "--occurrence",
      "occ-7",
      "--disposition",
      "confirm_effect",
    ]);

    for (const result of [partial, grant, confirm]) expect(JSON.parse(result.stdout).error.code).toBe("CC_USAGE");
    expect(fixture.requests).toEqual([]);
  });

  it("sends a seat's task commands for the server to resolve against its context", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_CONVERSATION: "conv-9" },
      respond: () => jsonReply({ ok: true, contextId: "run-1.agent" }),
    });
    await fixture.run(["context", "task", "complete", "t1"]);
    await fixture.run(["context", "task", "add", "t2", "--title", "Cover the refusal"]);

    expect(fixture.requests.map((r) => [r.url, bodyOf(r.init)])).toEqual([
      ["http://cc.test/api/projects/project-one/sessions/session-one/contexts/tasks", { kind: "complete", taskId: "t1" }],
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/contexts/tasks",
        { kind: "add", taskId: "t2", title: "Cover the refusal" },
      ],
    ]);
  });
});
