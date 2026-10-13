import { describe, expect, it } from "vitest";
import { createCcRuntimeFixture, jsonReply } from "../../testing/framework";

const identityEnv = { CC_CONVERSATION: "owner-1" };

const view = {
  runId: "run-1",
  title: "Fix the notice",
  kind: "agent",
  progress: { kind: "needs_owner", reasons: ["agent: halted (turn_failed)"] },
  revision: 4,
  definitionRevision: 1,
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
      waitingOnLaneProvision: null,
      waitingOnPublications: [],
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
        {
          questionId: "q-1",
          seat: "implementer",
          text: "Which file?\n- notice.ts: The one that fires twice\n- new.ts",
        },
      ],
      lastSummary: null,
      output: null,
      froze: { charter: 1, documents: [{ path: "plan.md", revision: 2 }] },
    },
  ],
  boundaries: [
    {
      seq: 1,
      kind: "halted",
      summary: "Fix the notice: halted (turn_failed).",
      recordedAt: "2026-10-03T10:05:00.000Z",
    },
  ],
  acts: [],
  stalled: [],
  halts: [],
  loops: [],
  lanes: [],
  documents: [],
  charter: null,
};

function bodyOf(init: { body?: unknown }): unknown {
  return typeof init.body === "string" ? JSON.parse(init.body) : undefined;
}

function artifactText(
  fixture: ReturnType<typeof createCcRuntimeFixture>,
  path: string,
): string {
  const bytes = fixture.kernelHost.filesSnapshot()[path];
  if (bytes === undefined) throw new Error(`No artifact at ${path}`);
  return new TextDecoder().decode(bytes);
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
    const result = await fixture.run([
      "run",
      "workflow",
      "--file",
      "/workflow.json",
    ]);

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
            {
              key: "a",
              brief: "A",
              dependsOn: ["b"],
              scope: { mode: "readOnly" },
            },
            {
              key: "b",
              brief: "B",
              dependsOn: ["a"],
              scope: { mode: "readOnly" },
            },
          ],
        }),
      },
      respond: () => jsonReply({}),
    });
    const result = await fixture.run([
      "run",
      "workflow-check",
      "--file",
      "/workflow.json",
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain(
      "Dependency cycle: a → b → a",
    );
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
              waitingOnLaneProvision: null,
              waitingOnPublications: [],
              pass: 1,
              progress: null,
              occurrence: null,
              tasks: [],
              seats: {},
              openQuestions: [],
              lastSummary: null,
              output: null,
              froze: null,
            },
          ],
        }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "- docs [run-1.docs]: not started, waits on agent",
    );
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
      waitingOnLaneProvision: null,
      waitingOnPublications: [],
      pass: 1,
      progress: null,
      occurrence: null,
      tasks: [],
      seats: {},
      openQuestions: [],
      lastSummary: null,
      output: null,
      froze: null,
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
          halts: [
            'loop "polish": "review" did not meet the exit condition in 2 passes',
          ],
          loops: [{ key: "polish", pass: 2, maxPasses: 2, state: "exhausted" }],
        }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "- fix [run-1.fix]: skipped (its route was not taken)",
    );
    expect(result.stdout).toContain(
      "- review [run-1.review.pass2] (loop polish, pass 2): succeeded",
    );
    expect(result.stdout).toContain("loop polish: pass 2 of 2, exhausted");
    expect(result.stdout).toContain(
      'cannot proceed: loop "polish": "review" did not meet the exit condition in 2 passes',
    );
  });

  it("names a halt once when it is also why the run needs its owner", async () => {
    const reason =
      'loop "polish": "review" did not meet the exit condition in 2 passes';
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
      waitingOnLaneProvision: null,
      waitingOnPublications: [],
      pass: 1,
      progress: null,
      occurrence: null,
      tasks: [],
      seats: {},
      openQuestions: [],
      lastSummary: null,
      output: null,
      froze: null,
    };
    for (const started of [false, true]) {
      for (const [progress, expected] of [
        [{ kind: "paused", draining: false }, "not started (run paused)"],
        [{ kind: "cancelled" }, "not started (run cancelled)"],
      ] as const) {
        // started: a start the run recorded that no context took up before the pause or cancel.
        const fixture = createCcRuntimeFixture({
          env: identityEnv,
          respond: () =>
            jsonReply({
              ...view,
              kind: "workflow",
              progress,
              contexts: [{ ...docs, started }],
            }),
        });
        const result = await fixture.run(["run", "show", "run-1"], "text");
        expect(result.stdout).toContain(`- docs [run-1.docs]: ${expected}`);
      }
    }
  });

  it("tells a pause still draining admitted work from a settled one, and names a paused context's next step", async () => {
    const paused = (draining: boolean) => ({
      ...view,
      progress: { kind: "paused", draining },
      contexts: [
        {
          ...view.contexts[0],
          progress: draining
            ? { kind: "paused", next: null, draining: true }
            : {
                kind: "paused",
                next: { kind: "running", obligation: { kind: "freeze" } },
                draining: false,
              },
        },
      ],
    });
    const show = async (draining: boolean) => {
      const fixture = createCcRuntimeFixture({
        env: identityEnv,
        respond: () => jsonReply(paused(draining)),
      });
      return fixture.run(["run", "show", "run-1"], "text");
    };

    const draining = await show(true);
    expect(draining.stdout).toContain(
      "— paused (draining: admitted work is still finishing)",
    );
    expect(draining.stdout).toContain(
      "- agent [run-1.agent]: paused (draining)",
    );
    const drained = await show(false);
    expect(drained.stdout).toContain("— paused (drained)");
    expect(drained.stdout).toContain(
      "- agent [run-1.agent]: paused (next: freeze)",
    );
  });

  it("tells the owner when Alex paused its run, so it does not resume it unasked", async () => {
    const at = "2026-10-03T10:04:00.000Z";
    const show = async (acts: unknown[]) => {
      const fixture = createCcRuntimeFixture({
        env: identityEnv,
        respond: () =>
          jsonReply({
            ...view,
            progress: { kind: "paused", draining: false },
            acts,
          }),
      });
      return fixture.run(["run", "show", "run-1"], "text");
    };
    const alexPaused = `Alex paused this run in Command Center at ${at}; leave it paused unless Alex asks you to resume it.`;

    expect(
      (await show([{ action: "pause", by: "person", at }])).stdout,
    ).toContain(alexPaused);
    // A lane retry does not lift the pause, so Alex's still holds.
    expect(
      (
        await show([
          { action: "pause", by: "person", at },
          { action: "retry_lane", by: "owner", at, lane: "api" },
        ])
      ).stdout,
    ).toContain(alexPaused);
    expect(
      (await show([{ action: "pause", by: "owner", at }])).stdout,
    ).not.toContain("Alex paused");
    // Resumed since, and paused again by a restart, which records no act.
    expect(
      (
        await show([
          { action: "pause", by: "person", at },
          { action: "resume", by: "person", at, dispositions: [] },
        ])
      ).stdout,
    ).not.toContain("Alex paused");
  });

  it("shows a context the run's pause holds as held, with its next step, once admitted work has finished", async () => {
    const underRunPause = (draining: boolean) => ({
      ...view,
      progress: { kind: "paused", draining },
      contexts: [
        {
          ...view.contexts[0],
          progress: { kind: "running", obligation: { kind: "freeze" } },
        },
      ],
    });
    const show = async (draining: boolean) => {
      const fixture = createCcRuntimeFixture({
        env: identityEnv,
        respond: () => jsonReply(underRunPause(draining)),
      });
      return fixture.run(["run", "show", "run-1"], "text");
    };

    expect((await show(true)).stdout).toContain(
      "- agent [run-1.agent]: running (admitted work finishing under the run's pause)",
    );
    expect((await show(false)).stdout).toContain(
      "- agent [run-1.agent]: held by the run's pause (next: freeze)",
    );
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
    // A question's options stay under it, indented as part of its context.
    expect(result.stdout).toContain(
      "  question q-1 from implementer: Which file?\n    - notice.ts: The one that fires twice\n    - new.ts\n",
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
              progress: {
                kind: "needs_owner",
                reasons: ['lane "api": publication blocked: notes.md'],
              },
              contexts: [
                {
                  ...view.contexts[0],
                  key: "integrate",
                  contextId: "run-1.integrate",
                  started: false,
                  progress: null,
                  occurrence: null,
                  waitingOnLaneProvision: null,
                  waitingOnPublications: ["api"],
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
    expect(shown.stdout).toContain(
      "- integrate [run-1.integrate]: not started, waits for lane api to publish",
    );
    expect(shown.stdout).toContain(
      "lane api [csm/session-1-api at /repo/.worktrees/session.1-api]: blocked (attempt 1): The session worktree has changes: notes.md",
    );

    expect(
      (await fixture.run(["run", "retry", "run-1", "--lane", "api"])).exitCode,
    ).toBe(0);
    expect(fixture.requests.map((r) => [r.url, bodyOf(r.init)]).at(-1)).toEqual(
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/control",
        { action: "retry", lane: "api" },
      ],
    );
  });

  it("amends a run's definition from the revision it was read at, and reports what still cannot proceed", async () => {
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
        jsonReply({
          ok: true,
          revision: 3,
          progress: { kind: "running" },
          halts: ['route: "triage" must take exactly one'],
          removedDocuments: ["glossary.md"],
        }),
    });
    const result = await fixture.run(
      [
        "run",
        "amend",
        "run-1",
        "--file",
        "/workflow.json",
        "--based-on",
        "2",
        "--reason",
        "Docs need the API first",
      ],
      "text",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.requests.map((r) => [r.url, bodyOf(r.init)])).toEqual([
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/amend",
        { definition, basedOn: 2, reason: "Docs need the API first" },
      ],
    ]);
    expect(result.stdout).toContain("revision 3");
    expect(result.stdout).toContain(
      'still cannot proceed: route: "triage" must take exactly one',
    );
    expect(result.stdout).toContain(
      "removed document glossary.md: work that starts from now no longer reads it",
    );
  });

  it("writes a workflow run's definition as written to a file that run amend takes unchanged", async () => {
    const definition = {
      title: "API then docs",
      contexts: [
        { key: "api", brief: "Build the API" },
        { key: "docs", brief: "Document it", dependsOn: ["api"] },
      ],
      documents: [{ path: "plan.md", revision: 2, description: "The plan" }],
    };
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: (request) =>
        request.url.endsWith("/definition")
          ? jsonReply({ runId: "run-1", revision: 2, definition })
          : jsonReply({
              ok: true,
              revision: 3,
              progress: { kind: "running" },
              halts: [],
              removedDocuments: [],
            }),
    });
    const read = await fixture.run(["run", "definition", "run-1"]);

    expect(read.exitCode, read.stderr).toBe(0);
    expect(fixture.requests[0]?.url).toBe(
      "http://cc.test/api/projects/project-one/sessions/session-one/runs/run-1/definition",
    );
    const { payload } = JSON.parse(read.stdout);
    expect(payload).toMatchObject({
      kind: "artifact",
      summary: { runId: "run-1", revision: 2 },
    });
    const file = artifactText(fixture, payload.artifact.path);
    expect(JSON.parse(file)).toEqual(definition);

    const amended = await fixture.run([
      "run",
      "amend",
      "run-1",
      "--file",
      payload.artifact.path,
      "--based-on",
      "2",
    ]);
    expect(amended.exitCode, amended.stderr).toBe(0);
    expect(bodyOf(fixture.requests[1]?.init ?? {})).toEqual({
      definition,
      basedOn: 2,
    });
  });

  it("names the definition file in text and writes it where --out says, inside the artifact directory", async () => {
    const definition = {
      title: "API",
      contexts: [{ key: "api", brief: "Build the API" }],
    };
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () => jsonReply({ runId: "run-1", revision: 2, definition }),
    });
    const result = await fixture.run(
      ["run", "definition", "run-1", "--out", "run-1.json"],
      "text",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Wrote run run-1's definition (revision 2) as JSON.",
    );
    expect(result.stdout).toContain(
      'artifact: {"path":"/artifacts/run-1.json"',
    );
    expect(JSON.parse(artifactText(fixture, "/artifacts/run-1.json"))).toEqual(
      definition,
    );
  });

  it("answers inline for an agent run, which has no definition to write", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () =>
        jsonReply({ runId: "run-1", revision: 1, definition: null }),
    });
    const result = await fixture.run(["run", "definition", "run-1"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).payload).toEqual({
      kind: "inline",
      data: { runId: "run-1", revision: 1, definition: null },
    });
    expect(Object.keys(fixture.kernelHost.filesSnapshot())).toEqual([]);
    const text = await fixture.run(["run", "definition", "run-1"], "text");
    expect(text.stdout).toContain(
      "Run run-1 has no workflow definition to amend",
    );
  });

  it("prints each change a refused amendment names", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      files: {
        "/workflow.json": JSON.stringify({
          title: "T",
          contexts: [{ key: "api", brief: "B" }],
        }),
      },
      respond: () =>
        jsonReply(
          {
            error:
              "The amendment changes work that already happened (2 changes)",
            code: "amendment_refused",
            issues: [
              {
                path: "definition",
                message: '"api" has started, so its request cannot change',
              },
              {
                path: "definition",
                message:
                  '"t" was skipped by a route that already ran, so it stays skipped',
              },
            ],
          },
          409,
        ),
    });
    const result = await fixture.run(
      ["run", "amend", "run-1", "--file", "/workflow.json"],
      "text",
    );

    expect(result.exitCode).not.toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('"api" has started, so its request cannot change');
    expect(output).toContain('"t" was skipped by a route that already ran');
  });

  it("writes line and paragraph separators and C1 controls escaped, so editors keep them, and the file still parses to the definition", async () => {
    const definition = {
      title: "Odd",
      contexts: [{ key: "api", brief: "First\u2028second\u2029third\u0085" }],
    };
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () => jsonReply({ runId: "run-1", revision: 1, definition }),
    });
    const result = await fixture.run(["run", "definition", "run-1"]);

    expect(result.exitCode, result.stderr).toBe(0);
    const file = artifactText(
      fixture,
      JSON.parse(result.stdout).payload.artifact.path,
    );
    expect(file).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(JSON.parse(file)).toEqual(definition);
  });

  it("shows the definition revision an amendment is based on", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () =>
        jsonReply({ ...view, kind: "workflow", definitionRevision: 2 }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("definition revision 2");
  });

  it("lists the run's documents with their revision, what they are for and when to read them", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () =>
        jsonReply({
          ...view,
          kind: "workflow",
          documents: [
            {
              path: "plan.md",
              revision: 2,
              source: "publish",
              by: "run-1.api",
              bytes: 7,
              description: "The plan",
              readWhen: "Before you start",
            },
            {
              path: "api-notes.md",
              revision: 1,
              source: "launch",
              bytes: 3,
              description: "API notes",
              appliesTo: ["api", "docs"],
            },
            {
              path: "glossary.md",
              revision: 3,
              source: "amend",
              reason: "Terms changed",
              bytes: 3,
              description: "Terms",
            },
          ],
        }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "document plan.md (revision 2, published by run-1.api): The plan — read when: Before you start",
    );
    expect(result.stdout).toContain(
      "document api-notes.md (revision 1, for api, docs): API notes",
    );
    expect(result.stdout).toContain(
      "document glossary.md (revision 3, amended: Terms changed): Terms",
    );
  });

  it("names the charter and document revisions each started context froze", async () => {
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () => jsonReply(view),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "  froze charter revision 1; plan.md revision 2",
    );
  });

  it("names the charter in force, its revision and why it was last amended", async () => {
    const charter = {
      revision: 2,
      mission: "Make the notice appear once.",
      reason: "Retries are out of scope",
    };
    const fixture = createCcRuntimeFixture({
      env: identityEnv,
      respond: () => jsonReply({ ...view, kind: "workflow", charter }),
    });
    const result = await fixture.run(["run", "show", "run-1"], "text");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "charter (revision 2, amended: Retries are out of scope): Make the notice appear once.",
    );
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

  it("publishes a file from the seat's working directory as the next revision of a run document", async () => {
    const fixture = createCcRuntimeFixture({
      env: { CC_CONVERSATION: "conv-9" },
      respond: () =>
        jsonReply({
          ok: true,
          runId: "run-1",
          path: "api.md",
          revision: 2,
          unchanged: false,
        }),
    });
    const result = await fixture.run(
      [
        "context",
        "doc",
        "publish",
        "notes/api.md",
        "--as",
        "api.md",
        "--description",
        "The API's endpoints",
        "--read-when",
        "Before you document it",
      ],
      "text",
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(fixture.requests.map((r) => [r.url, bodyOf(r.init)])).toEqual([
      [
        "http://cc.test/api/projects/project-one/sessions/session-one/contexts/documents",
        {
          file: "notes/api.md",
          as: "api.md",
          description: "The API's endpoints",
          readWhen: "Before you document it",
        },
      ],
    ]);
    expect(result.stdout).toContain(
      "Published api.md as revision 2 of run run-1: work that starts from now reads it.",
    );
  });
});
