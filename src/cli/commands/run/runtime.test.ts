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
      dependsOn: [],
      waitingOn: [],
      started: true,
      skipped: false,
      loop: null,
      lane: null,
      waitingOnLanes: [],
      pass: 1,
      progress: {
        kind: "halted",
        halt: "turn_failed",
        detail: "provider error",
      },
      occurrence: "occ-7",
      tasks: [{ id: "t1", title: "Route", status: "open" }],
      seats: { implementer: "conv-9" },
      openQuestions: [
        { questionId: "q-1", seat: "implementer", text: "Which file?" },
      ],
      lastSummary: null,
      output: null,
    },
  ],
  boundaries: [
    {
      seq: 1,
      kind: "halted",
      summary: "Fix the notice: halted (turn_failed).",
      recordedAt: "2026-10-03T10:05:00.000Z",
      notified: true,
    },
  ],
  stalled: [],
  halts: [],
  loops: [],
  lanes: [],
};

function bodyOf(init: { body?: unknown }): unknown {
  return typeof init.body === "string" ? JSON.parse(init.body) : undefined;
}

describe("run commands", () => {
  it("launches from a brief as the calling conversation and points at run show", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      files: {
        "/run.json": JSON.stringify({ brief: "Fix the duplicate notice" }),
      },
      respond: () =>
        jsonReply(
          {
            runId: "run-1",
            contextIds: ["run-1.agent"],
            progress: { kind: "running" },
          },
          202,
        ),
    });
    const result = await fixture.run(["run", "launch", "--file", "/run.json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    const request = fixture.requests[0];
    expect(request?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/runs",
    );
    expect(bodyOf(request?.init ?? {})).toEqual({
      brief: "Fix the duplicate notice",
    });
    const headers = (request?.init.headers ?? {}) as Record<string, string>;
    expect(JSON.parse(headers["x-cc-conversation-identity"] ?? "{}")).toEqual({
      sessionName: "session-one",
      conversationId: "owner-1",
    });
    const output = JSON.parse(result.stdout);
    expect(output).toMatchObject({
      effect: "applied",
      payload: { data: { runId: "run-1" } },
    });
    expect(output.hint).toContain("cctl run show -- run-1");
  });

  it("launches a workflow definition to the workflow endpoint", async () => {
    const definition = {
      title: "API then docs",
      contexts: [
        { key: "api", brief: "Build the API" },
        { key: "docs", brief: "Document it", dependsOn: ["api"] },
      ],
    };
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      files: { "/workflow.json": JSON.stringify(definition) },
      respond: () =>
        jsonReply(
          {
            runId: "run-1",
            contextIds: ["run-1.api", "run-1.docs"],
            progress: { kind: "running" },
          },
          202,
        ),
    });
    const result = await fixture.run(["run", "workflow", "--file", "/workflow.json"]);

    expect(result.exitCode, result.stderr).toBe(0);
    const request = fixture.requests[0];
    expect(request?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/runs/workflow",
    );
    expect(bodyOf(request?.init ?? {})).toEqual(definition);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "applied",
      payload: { data: { runId: "run-1" } },
    });
  });

  it("checks a workflow's topology locally, refusing a cycle at its location without sending anything", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      files: {
        "/workflow.json": JSON.stringify({
          title: "Cycle",
          contexts: [
            { key: "a", brief: "A", dependsOn: ["b"], scope: { mode: "readOnly" } },
            { key: "b", brief: "B", dependsOn: ["a"], scope: { mode: "readOnly" } },
          ],
        }),
      },
      respond: () => jsonReply({}),
    });
    const result = await fixture.run(["run", "workflow-check", "--file", "/workflow.json"]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain("Dependency cycle: a → b → a");
    expect(fixture.requests).toEqual([]);
  });

  it("shows a context that has not started with what it waits on", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () =>
        jsonReply({
          ...view,
          kind: "workflow",
          contexts: [
            ...view.contexts,
            {
              key: "docs",
              contextId: "run-1.docs",
              dependsOn: ["agent", "schema"],
              waitingOn: ["agent"],
              started: false,
              skipped: false,
              loop: null,
              lane: null,
              waitingOnLanes: [],
              pass: 1,
              progress: null,
              occurrence: null,
              tasks: [],
              seats: {},
              openQuestions: [],
              lastSummary: null,
              output: null,
            },
          ],
        }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("- docs [run-1.docs]: not started, waits on agent");
  });

  it("shows a skipped branch, a loop's pass, and what cannot proceed", async () => {
    const row = (key: string, extra: Record<string, unknown>) => ({
      key,
      contextId: `run-1.${key}`,
      dependsOn: [],
      waitingOn: [],
      started: false,
      skipped: false,
      loop: null,
      lane: null,
      waitingOnLanes: [],
      pass: 1,
      progress: null,
      occurrence: null,
      tasks: [],
      seats: {},
      openQuestions: [],
      lastSummary: null,
      output: null,
      ...extra,
    });
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () =>
        jsonReply({
          ...view,
          kind: "workflow",
          progress: { kind: "running" },
          contexts: [
            row("fix", { skipped: true }),
            row("review", {
              contextId: "run-1.review.pass2",
              loop: "polish",
              pass: 2,
              started: true,
              progress: { kind: "succeeded", candidateId: "c-2" },
            }),
          ],
          halts: ['loop "polish": "review" did not meet the exit condition in 2 passes'],
          loops: [{ key: "polish", pass: 2, maxPasses: 2, state: "exhausted" }],
        }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("- fix [run-1.fix]: skipped (its route was not taken)");
    expect(result.stdout).toContain("- review [run-1.review.pass2] (loop polish, pass 2): succeeded");
    expect(result.stdout).toContain("loop polish: pass 2 of 2, exhausted");
    expect(result.stdout).toContain('cannot proceed: loop "polish": "review" did not meet the exit condition in 2 passes');
  });

  it("names a halt once when it is also why the run needs its owner", async () => {
    const reason = 'loop "polish": "review" did not meet the exit condition in 2 passes';
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () =>
        jsonReply({
          ...view,
          progress: { kind: "needs_owner", reasons: [reason] },
          halts: [reason],
        }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.split(reason)).toHaveLength(2);
  });

  it("names the run's own state, not finished dependencies, for a context that will not start yet", async () => {
    const docs = {
      key: "docs",
      contextId: "run-1.docs",
      dependsOn: ["agent"],
      waitingOn: [],
      started: false,
      skipped: false,
      loop: null,
      lane: null,
      waitingOnLanes: [],
      pass: 1,
      progress: null,
      occurrence: null,
      tasks: [],
      seats: {},
      openQuestions: [],
      lastSummary: null,
      output: null,
    };
    for (const started of [false, true]) {
      for (const [progress, expected] of [
        [{ kind: "paused", draining: false }, "not started (run paused)"],
        [{ kind: "cancelled" }, "not started (run cancelled)"],
      ] as const) {
        // started: a start the run recorded that no context took up before the pause or cancel.
        const fixture = createCcRuntimeFixture({
          env: identityEnv,
          respond: () => jsonReply({ ...view, kind: "workflow", progress, contexts: [{ ...docs, started }] }),
        });
        const result = await fixture.run(["run", "show", "run-1"], "text");
        expect(result.stdout).toContain(`- docs [run-1.docs]: ${expected}`);
      }
    }
  });

  it("refuses an unknown launch option before sending anything", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      files: {
        "/run.json": JSON.stringify({ brief: "x", isolation: "worktree" }),
      },
      respond: () => jsonReply({}),
    });
    const result = await fixture.run(["run", "launch", "--file", "/run.json"]);

    expect(result.exitCode).not.toBe(0);
    expect(fixture.requests).toEqual([]);
  });

  it("shows halts with their occurrence, open questions and tasks", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () => jsonReply(view),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("needs you: agent: halted (turn_failed)");
    expect(result.stdout).toContain(
      "turn_failed: provider error; occurrence occ-7",
    );
    expect(result.stdout).toContain(
      "question q-1 from implementer: Which file?",
    );
    expect(result.stdout).toContain("task t1 open: Route");
  });

  it("answers a question and resumes past a halt with a disposition naming its occurrence", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: ({ url }) =>
        jsonReply(
          url.endsWith("/answer")
            ? { ok: true }
            : { ok: true, progress: { kind: "running" } },
        ),
    });
    expect(
      (
        await fixture.run([
          "run",
          "answer",
          "run-1",
          "--question",
          "q-1",
          "--text",
          "notice.ts",
        ])
      ).exitCode,
    ).toBe(0);
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
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/answer",
        { questionId: "q-1", text: "notice.ts" },
      ],
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/control",
        {
          action: "resume",
          dispositions: [
            {
              contextId: "run-1.agent",
              occurrence: "occ-7",
              disposition: { kind: "continue" },
            },
          ],
        },
      ],
    ]);
  });

  it("asks for a new attempt at a lane, and shows lanes and the work waiting for them", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: ({ url }) =>
        url.endsWith("/control")
          ? jsonReply({ ok: true, progress: { kind: "running" } })
          : jsonReply({
              ...view,
              kind: "workflow",
              progress: { kind: "needs_owner", reasons: ['lane "api": publication blocked: notes.md'] },
              contexts: [
                {
                  ...view.contexts[0],
                  key: "integrate",
                  contextId: "run-1.integrate",
                  started: false,
                  progress: null,
                  occurrence: null,
                  waitingOnLanes: ["api"],
                },
              ],
              lanes: [
                {
                  key: "api",
                  worktreePath: "/repo/.worktrees/session.1-api",
                  branch: "csm/session-1-api",
                  state: "blocked",
                  attempt: 1,
                  detail: "The session worktree has changes: notes.md",
                  commit: null,
                },
              ],
            }),
    });
    const shown = await fixture.run(["run", "show", "run-1"], "text");
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toContain("- integrate [run-1.integrate]: not started, waits for lane api to publish");
    expect(shown.stdout).toContain(
      "lane api [csm/session-1-api at /repo/.worktrees/session.1-api]: blocked (attempt 1): The session worktree has changes: notes.md",
    );

    expect((await fixture.run(["run", "retry", "run-1", "--lane", "api"])).exitCode).toBe(0);
    expect(fixture.requests.map((r) => [r.url, bodyOf(r.init)]).at(-1)).toEqual([
      "http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/control",
      { action: "retry", lane: "api" },
    ]);
  });

  it("refuses incomplete dispositions without sending them", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () => jsonReply({ ok: true }),
    });
    const partial = await fixture.run([
      "run",
      "resume",
      "run-1",
      "--disposition",
      "continue",
    ]);
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

    for (const result of [partial, grant, confirm])
      expect(JSON.parse(result.stdout).error.code).toBe("CC_USAGE");
    expect(fixture.requests).toEqual([]);
  });

  it("sends a seat's task commands for the server to resolve against its context", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_CONVERSATION: "conv-9" },
      respond: () => jsonReply({ ok: true, contextId: "run-1.agent" }),
    });
    await fixture.run(["context", "task", "complete", "t1"]);
    await fixture.run([
      "context",
      "task",
      "add",
      "t2",
      "--title",
      "Cover the refusal",
    ]);

    expect(fixture.requests.map((r) => [r.url, bodyOf(r.init)])).toEqual([
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/contexts/tasks",
        { kind: "complete", taskId: "t1" },
      ],
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/contexts/tasks",
        { kind: "add", taskId: "t2", title: "Cover the refusal" },
      ],
    ]);
  });
});
