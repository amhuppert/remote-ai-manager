import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { NextResponse } from "next/server";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createRunRouteHandlers, type RunRouteDeps } from "./route-handlers";
import { currentDocuments } from "./documents";
import {
  activeRunSchema,
  runPageSchema,
  runSummarySchema,
  runViewSchema,
} from "./schemas";
import type { Supervision } from "@/lib/supervision/supervision";
import {
  agentStartRequest,
  createSupervisionHarness,
  done,
  quiesce,
} from "@/lib/supervision/testing/supervision-fixture";

let fixture: PersistenceFixture;
let h: ReturnType<typeof createSupervisionHarness>;
let supervision: Supervision;
let sessionConversations: string[];
let routes: ReturnType<typeof createRunRouteHandlers>;
let tokenValid: boolean;
let seatResolutions: number;
/** A backend that was configured at launch and withdrawn since. */
let codexWithdrawn: boolean;
/** The branch prefix lanes are named with; configuration can change while a run lives. */
let branchPrefix: string;
/** Conversations the inbox cannot wake: owned, archived or not an ordinary conversation. */
let unwakeable: Set<string>;
let archived: Set<string>;
let deletedSessions: Set<string>;
/** Every candidate whose changes the page asked Workspace for. */
let diffed: Array<{ worktreePath: string; evidence: string }>;
/** Seat conversations deleted from the session since they ran. */
let deleted: Set<string>;

function identity(conversationId: string): Record<string, string> {
  return {
    "x-cc-conversation-identity": JSON.stringify({
      sessionName: "session",
      conversationId,
    }),
  };
}

function request(
  body: unknown,
  headers: Record<string, string>,
  method = "POST",
): Request {
  return new Request(
    "http://127.0.0.1/api/projects/repo/sessions/session/runs",
    {
      method,
      headers: { "content-type": "application/json", ...headers },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    },
  );
}

const params = (extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ name: "repo", session: "session", ...extra }),
});

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** Every request to freeze documents, with the worktree their files were read from. */
let snapshots: Array<{ worktreePath: string; paths: string[] }>;
/** The files a seat can publish, by path in its working directory, and every working directory read. */
let seatFiles: Record<string, string>;
let seatReads: string[];
/** When set, freezing a seat's file or an amendment's documents waits on it. */
let holdSeatFile: (() => Promise<void>) | null;
let holdDocuments: (() => Promise<void>) | null;

/** A hold the test releases, and a promise that settles once something waits on it. */
function hold(): {
  wait: () => Promise<void>;
  reached: Promise<void>;
  release: () => void;
} {
  let release = () => {};
  let reach = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  return {
    wait: async () => {
      reach();
      await released;
    },
    reached,
    release,
  };
}

async function launch(
  body: unknown = { brief: "Fix the duplicate notice" },
  caller = "owner-1",
) {
  const response = await routes.launch(
    request(body, identity(caller)),
    params(),
  );
  const payload = await json(response);
  await quiesce(supervision);
  return { response, payload };
}

beforeEach(() => {
  fixture = createPersistenceFixture();
  h = createSupervisionHarness(fixture);
  supervision = h.compose();
  sessionConversations = ["owner-1", "other-1"];
  tokenValid = true;
  seatResolutions = 0;
  codexWithdrawn = false;
  branchPrefix = "csm";
  unwakeable = new Set();
  archived = new Set();
  deletedSessions = new Set();
  diffed = [];
  deleted = new Set();
  snapshots = [];
  seatFiles = {};
  seatReads = [];
  holdSeatFile = null;
  holdDocuments = null;
  let sequence = 0;
  const deps: RunRouteDeps = {
    auth: {
      async requireToken() {
        return tokenValid
          ? null
          : NextResponse.json({ error: "Invalid token" }, { status: 401 });
      },
      async validateOptionalToken(req) {
        if (!req.headers.has("authorization")) return { kind: "absent" };
        return tokenValid ? { kind: "valid" } : { kind: "invalid" };
      },
    },
    async resolveProjectPath(name) {
      return name === "repo" ? "/repo" : null;
    },
    async laneTargets({ sessionWorktreePath }) {
      return (laneId) => ({
        worktreePath: `${sessionWorktreePath}.${laneId}`,
        branch: `${branchPrefix}/lane-${laneId}`,
      });
    },
    async getSession(_projectPath, sessionName) {
      if (deletedSessions.has(sessionName)) return null;
      if (sessionName === "session-2") {
        return {
          sessionName,
          worktreePath: "/repo/.worktrees/session-2",
          branchName: "csm/session-2",
          conversations: [{ id: "s2-conv" }],
        };
      }
      if (sessionName !== "session") return null;
      return {
        sessionName,
        worktreePath: "/repo/.worktrees/session",
        branchName: "csm/session",
        conversations: [
          ...sessionConversations.map((id) => ({ id })),
          ...Object.values(supervisionSeats()).map((id) => ({ id })),
        ],
      };
    },
    supervision: () => supervision,
    async ownerWakeable(_projectPath, conversationId) {
      return !unwakeable.has(conversationId);
    },
    async resolveSeats({ request: launchRequest }) {
      seatResolutions += 1;
      if (
        launchRequest.backend === "cursor" ||
        (launchRequest.backend === "codex" && codexWithdrawn)
      ) {
        return {
          ok: false,
          status: 400,
          error: "Cursor is not available here",
          code: "backend_unavailable",
        };
      }
      const seat =
        launchRequest.backend === "codex"
          ? {
              backend: "codex" as const,
              modelSelection: { modelId: "gpt-5.4", parameters: {} },
            }
          : {
              backend: "claude" as const,
              modelSelection: { modelId: "sonnet", parameters: {} },
            };
      return {
        ok: true,
        seats: {
          implementer: seat,
          reviewers: (launchRequest.reviewers ?? []).map(() => seat),
        },
      };
    },
    newRunId: () => {
      sequence += 1;
      return `run-${sequence}`;
    },
    // Freezes each document as the bytes its path names; a path starting "missing" has no file.
    // A kept revision takes the bytes the run's latest revision of its path holds.
    async snapshotDocuments(requests, worktreePath, current = []) {
      snapshots.push({ worktreePath, paths: requests.map((r) => r.path) });
      if (holdDocuments !== null) await holdDocuments();
      const latest = new Map(currentDocuments(current).map((r) => [r.path, r]));
      const issues = requests.flatMap((r, index) =>
        r.path.startsWith("missing")
          ? [
              {
                path: ["documents", index, "from"],
                message: `No file at "${r.from ?? ""}" in the session worktree`,
              },
            ]
          : r.revision !== undefined &&
              latest.get(r.path)?.revision !== r.revision
            ? [
                {
                  path: ["documents", index, "revision"],
                  message: `its latest is revision ${latest.get(r.path)?.revision ?? "none"}`,
                },
              ]
            : [],
      );
      if (issues.length > 0) return { ok: false, issues };
      return {
        ok: true,
        documents: requests.map((r) => {
          const kept =
            r.revision !== undefined ? latest.get(r.path) : undefined;
          return {
            path: r.path,
            artifactId:
              kept?.document.artifactId ??
              `sha256:${r.contents ?? r.from ?? ""}`,
            bytes: kept?.document.bytes ?? 1,
            description: r.description,
            ...(r.readWhen !== undefined ? { readWhen: r.readWhen } : {}),
            ...(r.appliesTo !== undefined ? { appliesTo: r.appliesTo } : {}),
            ...(r.revision !== undefined ? { seen: r.revision } : {}),
          };
        }),
      };
    },
    // Freezes the default bundle as the mission, and each named key's as the mission and key.
    async freezeCharter(charter) {
      const named = [
        ...(charter.invariants ?? []),
        ...(charter.sourcesOfTruth ?? []),
      ].flatMap((e) => e.appliesTo ?? []);
      return {
        charter,
        bundles: {
          default: `sha256:${charter.mission}`,
          byKey: Object.fromEntries(
            named.map((key) => [key, `sha256:${charter.mission}-${key}`]),
          ),
        },
      };
    },
    // The owner reads as "Owner one"; each seat's conversation cost 0.25 over two turns.
    async sessionConversations() {
      return new Map([
        [
          "owner-1",
          {
            title: "Owner one",
            backend: "claude" as const,
            working: false,
            costUsd: 1,
            turns: 4,
          },
        ],
        ...Object.values(supervisionSeats())
          .filter((id) => !deleted.has(id))
          .map(
            (id) =>
              [
                id,
                {
                  title: id,
                  backend: "claude" as const,
                  working: false,
                  costUsd: 0.25,
                  turns: 2,
                },
              ] as const,
          ),
      ]);
    },
    // A frozen document's text is what its fake artifact id names.
    async readText(artifactId) {
      return artifactId.replace(/^sha256:/, "");
    },
    async candidateChanges({ worktreePath, evidence }) {
      diffed.push({ worktreePath, evidence });
      return {
        ok: true,
        diff: { files: [], totalAdditions: 3, totalDeletions: 1 },
      };
    },
    // Freezes a seat's file as its contents.
    async snapshotFile(worktreePath, file) {
      seatReads.push(worktreePath);
      if (holdSeatFile !== null) await holdSeatFile();
      const contents = seatFiles[file];
      return contents === undefined
        ? {
            ok: false,
            message: `No file at "${file}" in your working directory`,
          }
        : {
            ok: true,
            path: file,
            artifactId: `sha256:${contents}`,
            bytes: contents.length,
          };
    },
    async archivedProjects() {
      return archived;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  routes = createRunRouteHandlers(deps);
});
afterEach(() => fixture.close());

function supervisionSeats(): Record<string, string> {
  const seats: Record<string, string> = {};
  for (let i = 1; i <= h.conversations; i += 1)
    seats[`seat-${i}`] = `conv-${i}`;
  return seats;
}

describe("run routes", () => {
  it("launches an agent run owned by the calling conversation and shows its result", async () => {
    const { response, payload } = await launch();
    expect(response.status).toBe(202);
    expect(payload).toMatchObject({ runId: "run-1" });

    const shown = await routes.show(
      request(null, identity("owner-1"), "GET"),
      params({ runId: "run-1" }),
    );
    expect(shown.status).toBe(200);
    const shownView = await json(shown);
    expect(runViewSchema.safeParse(shownView).success).toBe(true);
    expect(shownView).toMatchObject({
      runId: "run-1",
      title: "Fix the duplicate notice",
      progress: { kind: "succeeded" },
      ownerConversationId: "owner-1",
      contexts: [
        {
          key: "agent",
          output: { summary: "Done." },
          seats: { implementer: "conv-1" },
        },
      ],
    });
  });

  it("freezes an agent launch's documents from the session worktree; its context reads them under the run's documents path", async () => {
    const { response } = await launch({
      brief: "Fix the duplicate notice",
      documents: [
        { path: "plan.md", from: "docs/plan.md", description: "The plan" },
      ],
    });

    expect(response.status).toBe(202);
    expect(snapshots).toEqual([
      { worktreePath: "/repo/.worktrees/session", paths: ["plan.md"] },
    ]);
    const contextId =
      supervision.runs.observe("run-1")?.record.facts.invocations[0]
        ?.contextId ?? "";
    expect(
      supervision.contexts.observe(contextId)?.record.facts.contract.current
        .documents,
    ).toEqual([
      {
        artifactId: "sha256:docs/plan.md",
        path: `.cc/run-docs/${contextId}/plan.md`,
        description: "The plan",
      },
    ]);
    const shown = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(shown.documents).toEqual([
      {
        path: "plan.md",
        revision: 1,
        source: "launch",
        bytes: 1,
        description: "The plan",
      },
    ]);
  });

  it("refuses a launch whose documents cannot be frozen, naming each problem, and launches nothing", async () => {
    const { response, payload } = await launch({
      brief: "Fix the duplicate notice",
      documents: [
        { path: "missing.md", from: "docs/missing.md", description: "Gone" },
      ],
    });

    expect(response.status).toBe(400);
    expect(payload).toEqual({
      error: "Invalid documents",
      issues: [
        {
          path: "documents.0.from",
          message: 'No file at "docs/missing.md" in the session worktree',
        },
      ],
    });
    expect(supervision.runs.observe("run-1")).toBeNull();
  });

  it("shows a run only within its own session", async () => {
    await launch();
    const elsewhere = new Request(
      "http://127.0.0.1/api/projects/repo/sessions/session-2/runs/run-1",
      {
        headers: {
          "x-cc-conversation-identity": JSON.stringify({
            sessionName: "session-2",
            conversationId: "s2-conv",
          }),
        },
      },
    );
    const shown = await routes.show(elsewhere, {
      params: Promise.resolve({
        name: "repo",
        session: "session-2",
        runId: "run-1",
      }),
    });
    expect(shown.status).toBe(404);
  });

  it("refuses a launch from a supervised seat, whose child would wait on the seat's own workspace", async () => {
    await launch();
    const response = await routes.launch(
      request({ brief: "Nested work" }, identity("conv-1")),
      params(),
    );
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: "seat_cannot_launch" });
  });

  it("refuses a launch from a conversation the inbox cannot wake, since nothing would reach it", async () => {
    unwakeable.add("other-1");
    const response = await routes.launch(
      request({ brief: "Fix the notice" }, identity("other-1")),
      params(),
    );
    expect(response.status).toBe(409);
    expect(await json(response)).toMatchObject({ code: "owner_not_wakeable" });
    expect(supervision.runs.observe("run-1")).toBeNull();
  });

  it("refuses a launch without a verified calling conversation, and an unknown option", async () => {
    expect(
      (await routes.launch(request({ brief: "x" }, {}), params())).status,
    ).toBe(403);
    expect(
      (
        await routes.launch(
          request({ brief: "x" }, identity("stranger")),
          params(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await routes.launch(
          request({ brief: "x", isolation: "worktree" }, identity("owner-1")),
          params(),
        )
      ).status,
    ).toBe(400);
    tokenValid = false;
    expect(
      (
        await routes.launch(
          request({ brief: "x" }, identity("owner-1")),
          params(),
        )
      ).status,
    ).toBe(401);
  });

  it("lets only the owner answer a question that belongs to its run", async () => {
    h.script = async (input, self) => {
      if (h.turnMessages.length > 1) return done("Used notice.ts");
      self.requests.open({
        conversationId: input.conversationId,
        attemptId: input.attemptId,
        questionText: "Which file?",
        questions: [{ question: "Which file?" }],
      });
      return done("Asked.");
    };
    await launch();
    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    const contexts = view.contexts as Array<{
      openQuestions: Array<{ questionId: string; text: string }>;
    }>;
    const question = contexts[0]?.openQuestions[0];
    expect(question?.text).toBe("Which file?");

    const foreign = await routes.answer(
      request(
        { questionId: question?.questionId, text: "notice.ts" },
        identity("other-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(foreign.status).toBe(403);
    const unknown = await routes.answer(
      request(
        { questionId: "not-a-question", text: "notice.ts" },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(unknown.status).toBe(404);

    const answered = await routes.answer(
      request(
        { questionId: question?.questionId, text: "notice.ts" },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(answered.status).toBe(200);
    await quiesce(supervision);
    expect(supervision.runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
  });

  it("finishes cancelling a run whose agent waits for its owner's answer, withdrawing the question", async () => {
    h.script = async (input, self) => {
      self.requests.open({
        conversationId: input.conversationId,
        attemptId: input.attemptId,
        questionText: "Which file?",
        questions: [{ question: "Which file?" }],
      });
      return done("Asked.");
    };
    await launch();
    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    const questionId = (
      view.contexts as Array<{ openQuestions: Array<{ questionId: string }> }>
    )[0]?.openQuestions[0]?.questionId;
    expect(questionId).toBeDefined();

    const cancelled = await routes.control(
      request({ action: "cancel" }, identity("owner-1")),
      params({ runId: "run-1" }),
    );
    expect(cancelled.status).toBe(200);
    await quiesce(supervision);
    expect(supervision.runs.observe("run-1")?.record.progress).toEqual({
      kind: "cancelled",
    });
    expect(supervision.requests.question(questionId ?? "")?.state).toBe(
      "withdrawn",
    );
    // The page names the cancel once: who asked for it, not also that it finished.
    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    expect(
      page.activity
        .filter((event) => event.kind === "cancelled")
        .map((event) => event.summary),
    ).toEqual(["Cancelled by the owner"]);
    expect(page.finishedAt).not.toBeNull();
  });

  it("pauses, resumes and cancels a run for its owner, refusing another conversation", async () => {
    h.script = () => new Promise(() => {});
    await routes.launch(
      request({ brief: "Long work" }, identity("owner-1")),
      params(),
    );
    await quiesce(supervision, false);

    const control = (action: string, caller = "owner-1") =>
      routes.control(
        request({ action }, identity(caller)),
        params({ runId: "run-1" }),
      );
    expect((await control("pause", "other-1")).status).toBe(403);
    expect((await control("pause")).status).toBe(200);
    expect(supervision.runs.observe("run-1")?.record.progress.kind).toBe(
      "paused",
    );
    expect((await control("resume")).status).toBe(200);
    expect(supervision.runs.observe("run-1")?.record.progress.kind).toBe(
      "running",
    );
    expect((await control("cancel")).status).toBe(200);
    expect(["stopping", "cancelled"]).toContain(
      supervision.runs.observe("run-1")?.record.progress.kind,
    );
  });

  it("launches a workflow whose dependent context starts from its dependency's accepted result", async () => {
    const response = await routes.launchWorkflow(
      request(
        {
          title: "API then docs",
          contexts: [
            {
              key: "api",
              brief: "Build the API",
              scope: { mode: "owned", paths: ["src/api"] },
            },
            { key: "docs", brief: "Document the API", dependsOn: ["api"] },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    expect(response.status).toBe(202);
    expect(await json(response)).toMatchObject({
      runId: "run-1",
      contextIds: ["run-1.api", "run-1.docs"],
    });
    await quiesce(supervision);

    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(runViewSchema.safeParse(view).success).toBe(true);
    expect(view).toMatchObject({
      kind: "workflow",
      title: "API then docs",
      progress: { kind: "succeeded" },
      contexts: [
        { key: "api", dependsOn: [], output: { summary: "Done." } },
        { key: "docs", dependsOn: ["api"], output: { summary: "Done." } },
      ],
    });
    expect(
      supervision.contexts.observe("run-1.docs")?.record.facts.contract.current
        .inputs,
    ).toEqual([
      { key: "api", title: "Build the API", output: { summary: "Done." } },
    ]);
  });

  it("freezes each context's own resolved seat, and names the context whose seat cannot be resolved", async () => {
    h.script = () => new Promise(() => {});
    const launched = await routes.launchWorkflow(
      request(
        {
          title: "Mixed backends",
          contexts: [
            {
              key: "api",
              brief: "Build the API",
              backend: "codex",
              scope: { mode: "owned", paths: ["src/api"] },
            },
            {
              key: "ui",
              brief: "Build the UI",
              scope: { mode: "owned", paths: ["src/ui"] },
            },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    expect(launched.status).toBe(202);
    const definition =
      supervision.runs.observe("run-1")?.record.facts.definition.contexts;
    expect(
      definition?.map((c) => [c.key, c.request.contract.implementer.backend]),
    ).toEqual([
      ["api", "codex"],
      ["ui", "claude"],
    ]);

    const refused = await routes.launchWorkflow(
      request(
        {
          title: "Unavailable backend",
          contexts: [
            { key: "api", brief: "Build the API" },
            {
              key: "docs",
              brief: "Document it",
              backend: "cursor",
              dependsOn: ["api"],
            },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    expect(refused.status).toBe(400);
    expect(await json(refused)).toMatchObject({
      code: "backend_unavailable",
      context: "docs",
      error: expect.stringContaining('"docs"'),
    });
  });

  it("refuses an invalid topology before resolving any seat", async () => {
    const response = await routes.launchWorkflow(
      request(
        {
          title: "Cycle with an unavailable seat",
          contexts: [
            {
              key: "a",
              brief: "A",
              backend: "cursor",
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
        },
        identity("owner-1"),
      ),
      params(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      issues: [{ path: "contexts.1.dependsOn" }],
    });
    expect(seatResolutions).toBe(0);
  });

  it("refuses a workflow launch from a supervised seat", async () => {
    await launch();
    const response = await routes.launchWorkflow(
      request(
        { title: "Nested", contexts: [{ key: "a", brief: "Nested work" }] },
        identity("conv-1"),
      ),
      params(),
    );
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: "seat_cannot_launch" });
  });

  it("reports only the dependencies a waiting context still waits on", async () => {
    h.script = async (input) =>
      input.request.message.startsWith("# Slow")
        ? new Promise(() => {})
        : done("Done.");
    await routes.launchWorkflow(
      request(
        {
          title: "Fan in",
          contexts: [
            {
              key: "api",
              title: "API",
              brief: "Build the API",
              scope: { mode: "owned", paths: ["src/api"] },
            },
            {
              key: "slow",
              title: "Slow",
              brief: "Take a while",
              scope: { mode: "owned", paths: ["src/slow"] },
            },
            { key: "docs", brief: "Document both", dependsOn: ["api", "slow"] },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision, false);

    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(view.contexts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "api",
          progress: expect.objectContaining({ kind: "succeeded" }),
        }),
        expect.objectContaining({
          key: "docs",
          started: false,
          waitingOn: ["slow"],
        }),
      ]),
    );
  });

  it("shows contexts that have not started yet with what they wait on", async () => {
    h.script = () => new Promise(() => {});
    await routes.launchWorkflow(
      request(
        {
          title: "API then docs",
          contexts: [
            { key: "api", brief: "Build the API" },
            { key: "docs", brief: "Document the API", dependsOn: ["api"] },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision, false);

    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(runViewSchema.safeParse(view).success).toBe(true);
    expect(view.contexts).toEqual([
      expect.objectContaining({
        key: "api",
        contextId: "run-1.api",
        started: true,
      }),
      expect.objectContaining({
        key: "docs",
        contextId: "run-1.docs",
        started: false,
        progress: null,
        dependsOn: ["api"],
        waitingOn: ["api"],
      }),
    ]);
  });

  it("shows a branch a route did not take as skipped", async () => {
    h.script = async () => ({
      ...done("Triaged."),
      structuredOutput: { kind: "feature" },
    });
    await routes.launchWorkflow(
      request(
        {
          title: "Routed",
          contexts: [
            {
              key: "triage",
              brief: "Triage the report",
              scope: { mode: "readOnly" },
              outputSchema: {
                type: "object",
                properties: {
                  kind: { type: "string", enum: ["bug", "feature"] },
                },
                required: ["kind"],
              },
              routing: { cardinality: "exactlyOne" },
            },
            {
              key: "fix",
              brief: "Fix it",
              dependsOn: [
                {
                  key: "triage",
                  when: {
                    schema: {
                      type: "object",
                      properties: { kind: { const: "bug" } },
                    },
                  },
                },
              ],
            },
            {
              key: "design",
              brief: "Design it",
              dependsOn: [{ key: "triage", when: { else: true } }],
            },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(runViewSchema.safeParse(view).success).toBe(true);
    expect(view.progress).toEqual({ kind: "succeeded" });
    expect(view.contexts).toEqual([
      expect.objectContaining({ key: "triage", started: true, skipped: false }),
      expect.objectContaining({
        key: "fix",
        started: false,
        skipped: true,
        waitingOn: [],
      }),
      expect.objectContaining({ key: "design", started: true, skipped: false }),
    ]);

    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    expect(page.edges).toEqual([
      {
        from: "triage",
        to: "fix",
        guard: {
          label: '{"type":"object","properties":{"kind":{"const":"bug"}}}',
          state: "not_taken",
        },
        outputOnly: false,
      },
      {
        from: "triage",
        to: "design",
        guard: { label: "else", state: "taken" },
        outputOnly: false,
      },
    ]);
    const fix = page.contexts.find((context) => context.key === "fix");
    expect(fix?.state).toEqual({
      kind: "skipped",
      reason: "Its route was not taken",
    });
    expect(fix?.stages.every((stage) => stage.state === "skipped")).toBe(true);
    // A branch not taken is neither done nor left to do.
    const [summary] = z
      .array(runSummarySchema)
      .parse(await json(await routes.list(request(null, {}, "GET"), params())));
    expect(summary?.contexts).toEqual({ done: 2, total: 2 });
  });

  it("shows the page for a dependency keyed like a built-in property, with no guard on it", async () => {
    h.script = async () => ({
      ...done("Triaged."),
      structuredOutput: { kind: "feature" },
    });
    await routes.launchWorkflow(
      request(
        {
          title: "Keys",
          contexts: [
            { key: "constructor", brief: "Prepare it" },
            {
              key: "triage",
              brief: "Triage it",
              dependsOn: ["constructor"],
              scope: { mode: "readOnly" },
              outputSchema: {
                type: "object",
                properties: { kind: { type: "string" } },
                required: ["kind"],
              },
            },
            {
              key: "join",
              brief: "Join them",
              dependsOn: [
                "constructor",
                {
                  key: "triage",
                  when: {
                    schema: {
                      type: "object",
                      properties: { kind: { const: "feature" } },
                    },
                  },
                },
              ],
            },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    const shown = await routes.page(
      request(null, {}, "GET"),
      params({ runId: "run-1" }),
    );
    expect(shown.status).toBe(200);
    const page = runPageSchema.parse(await json(shown));
    expect(
      page.edges.find(
        (edge) => edge.from === "constructor" && edge.to === "join",
      ),
    ).toEqual({
      from: "constructor",
      to: "join",
      guard: null,
      outputOnly: false,
    });
  });

  it("shows a loop's current pass and why the run halted when the loop ran out of passes", async () => {
    h.script = async () => ({
      ...done("Reviewed."),
      structuredOutput: { approved: false },
    });
    await routes.launchWorkflow(
      request(
        {
          title: "Polish",
          contexts: [
            { key: "implement", brief: "Implement it" },
            {
              key: "review",
              brief: "Review it",
              dependsOn: ["implement"],
              outputSchema: {
                type: "object",
                properties: { approved: { type: "boolean" } },
                required: ["approved"],
              },
            },
          ],
          loops: [
            {
              key: "polish",
              body: ["implement", "review"],
              entry: "implement",
              exit: "review",
              until: {
                schema: {
                  type: "object",
                  properties: { approved: { const: true } },
                },
              },
              maxPasses: 2,
            },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(runViewSchema.safeParse(view).success).toBe(true);
    expect(view.contexts).toEqual([
      expect.objectContaining({
        key: "implement",
        contextId: "run-1.implement.pass2",
        loop: "polish",
        pass: 2,
      }),
      expect.objectContaining({
        key: "review",
        contextId: "run-1.review.pass2",
        loop: "polish",
        pass: 2,
      }),
    ]);
    expect(view.loops).toEqual([
      { key: "polish", pass: 2, maxPasses: 2, state: "exhausted" },
    ]);
    expect(view.progress).toEqual({
      kind: "needs_owner",
      reasons: [
        'loop "polish": "review" did not meet the exit condition in 2 passes',
      ],
    });
    expect(view.halts).toEqual([
      'loop "polish": "review" did not meet the exit condition in 2 passes',
    ]);

    // The run page keeps each earlier pass's evidence beside the current one.
    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    const [implement] = page.contexts;
    expect(implement?.invocationId).toBe("run-1.implement.pass2");
    expect(implement?.loop).toEqual({ key: "polish", pass: 2, maxPasses: 2 });
    expect(
      implement?.previousInvocations.map((pass) => [
        pass.invocationId,
        pass.loop?.pass,
        pass.state.kind,
      ]),
    ).toEqual([["run-1.implement", 1, "succeeded"]]);
    expect(page.loops).toEqual([
      expect.objectContaining({
        key: "polish",
        body: ["implement", "review"],
        pass: 2,
        state: "exhausted",
      }),
    ]);
    expect(page.attention).toEqual([
      expect.objectContaining({
        kind: "run_halt",
        halt: "loop_exhausted",
        clearedBy: "amend",
      }),
    ]);
    expect(
      page.activity.filter((event) => event.kind === "started"),
    ).toHaveLength(4);

    // Once cancelled, the halt is history: nothing is left for anyone to act on.
    await routes.control(
      request({ action: "cancel" }, {}),
      params({ runId: "run-1" }),
    );
    await quiesce(supervision);
    const cancelled = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    expect(cancelled.status).toEqual({ kind: "cancelled" });
    expect(cancelled.attention).toEqual([]);
    expect(cancelled.loops[0]?.state).toBe("exhausted");
    const [summary] = z
      .array(runSummarySchema)
      .parse(await json(await routes.list(request(null, {}, "GET"), params())));
    expect(summary?.attention).toBe(0);
  });

  it("shows a loop whose entry route was not taken as skipped", async () => {
    h.script = async () => ({
      ...done("Gated."),
      structuredOutput: { go: false },
    });
    await routes.launchWorkflow(
      request(
        {
          title: "Gated loop",
          contexts: [
            {
              key: "gate",
              brief: "Decide",
              scope: { mode: "readOnly" },
              outputSchema: {
                type: "object",
                properties: { go: { type: "boolean" } },
                required: ["go"],
              },
            },
            {
              key: "implement",
              brief: "Implement it",
              dependsOn: [
                {
                  key: "gate",
                  when: {
                    schema: {
                      type: "object",
                      properties: { go: { const: true } },
                    },
                  },
                },
              ],
            },
            {
              key: "review",
              brief: "Review it",
              dependsOn: ["implement"],
              outputSchema: {
                type: "object",
                properties: { approved: { type: "boolean" } },
                required: ["approved"],
              },
            },
          ],
          loops: [
            {
              key: "polish",
              body: ["implement", "review"],
              entry: "implement",
              exit: "review",
              until: {
                schema: {
                  type: "object",
                  properties: { approved: { const: true } },
                },
              },
              maxPasses: 2,
            },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(view.progress).toEqual({ kind: "succeeded" });
    expect(view.loops).toEqual([
      { key: "polish", pass: 0, maxPasses: 2, state: "skipped" },
    ]);
  });

  it("runs a lane, retries a publication the session's changes blocked, and then runs the work that needs it", async () => {
    const session = "/repo/.worktrees/session";
    h.laneGit.state.heads.set("csm/session", "h0");
    h.laneGit.state.dirt.set(session, ["notes.md"]);
    await routes.launchWorkflow(
      request(
        {
          title: "Lane then integrate",
          contexts: [
            { key: "api", brief: "Build the API", lane: "api" },
            { key: "integrate", brief: "Integrate", dependsOn: ["api"] },
          ],
          lanes: [{ key: "api", checks: ["typecheck"] }],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    const show = async () =>
      json(
        await routes.show(
          request(null, identity("owner-1"), "GET"),
          params({ runId: "run-1" }),
        ),
      );
    const blocked = await show();
    expect(runViewSchema.safeParse(blocked).success).toBe(true);
    expect(blocked.progress).toMatchObject({ kind: "needs_owner" });
    expect(blocked.lanes).toEqual([
      expect.objectContaining({
        key: "api",
        state: "blocked",
        attempt: 1,
        detail: expect.stringContaining("notes.md"),
      }),
    ]);
    expect(blocked.contexts).toEqual([
      expect.objectContaining({
        key: "api",
        lane: "api",
        contextId: "run-1.api",
      }),
      expect.objectContaining({
        key: "integrate",
        lane: null,
        started: false,
        waitingOnPublications: ["api"],
      }),
    ]);
    expect(h.checksRun).toEqual([
      expect.objectContaining({
        command: "typecheck",
        bindingId: expect.stringContaining("lane:"),
      }),
    ]);

    h.laneGit.state.dirt.set(session, []);
    const retried = await routes.control(
      request({ action: "retry", lane: "api" }, identity("owner-1")),
      params({ runId: "run-1" }),
    );
    expect(retried.status).toBe(200);
    await quiesce(supervision);
    const done = await show();
    expect(done.progress).toEqual({ kind: "succeeded" });
    expect(done.lanes).toEqual([
      expect.objectContaining({ key: "api", state: "published", attempt: 2 }),
    ]);
    expect(h.laneGit.state.removed).toEqual([
      expect.stringContaining("session."),
    ]);
  });

  it("refuses an invalid workflow definition with every located problem, launching nothing", async () => {
    const response = await routes.launchWorkflow(
      request(
        {
          title: "Overlap",
          contexts: [
            { key: "a", brief: "A" },
            { key: "b", brief: "B", dependsOn: ["ghost"] },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      issues: [{ path: "contexts.1.dependsOn.0" }],
    });
    expect(supervision.runs.observe("run-1")).toBeNull();
  });

  it("lists a person every current run across sessions, with what each needs of them", async () => {
    await launch({ brief: "Finishes on its own" });
    await launch({ brief: "Waits for Alex", humanApproval: true });

    const response = await routes.active(request(null, {}, "GET"), params());

    const asked = h.recorded.find(
      (boundary) => boundary.runId === "run-2" && boundary.kind === "approval",
    );
    expect(response.status).toBe(200);
    expect(z.array(activeRunSchema).parse(await json(response))).toEqual([
      {
        runId: "run-2",
        title: "Waits for Alex",
        kind: "agent",
        projectName: "repo",
        sessionName: "session",
        status: { kind: "needs_input" },
        attention: 1,
        approvals: 1,
        contexts: { done: 0, total: 1 },
        startedAt: expect.any(String),
        askedAt: asked?.recordedAt,
      },
    ]);
  });

  it("asks nothing of the person for a run waiting on its seat's question, which is its owner's to answer", async () => {
    h.script = async (input, self) => {
      self.requests.open({
        conversationId: input.conversationId,
        attemptId: input.attemptId,
        questionText: "Which file?",
        questions: [{ question: "Which file?" }],
      });
      return done("Asked.");
    };
    await launch();

    const listed = z
      .array(activeRunSchema)
      .parse(
        await json(await routes.active(request(null, {}, "GET"), params())),
      );

    expect(listed).toEqual([
      expect.objectContaining({ attention: 0, approvals: 0, askedAt: null }),
    ]);
  });

  it("keeps the active runs to the person, and leaves out archived projects", async () => {
    await launch({ brief: "Waits for Alex", humanApproval: true });

    const agent = await routes.active(
      request(null, identity("owner-1"), "GET"),
      params(),
    );
    expect(agent.status).toBe(403);

    archived = new Set(["/repo"]);
    const listed = await routes.active(request(null, {}, "GET"), params());
    expect(await json(listed)).toEqual([]);
  });

  it("leaves out a run whose session was deleted, since its page cannot be opened", async () => {
    await launch({ brief: "Waits for Alex", humanApproval: true });

    deletedSessions = new Set(["session"]);
    const listed = await routes.active(request(null, {}, "GET"), params());

    expect(await json(listed)).toEqual([]);
  });

  it("launches an agent whose result waits for a person's approval on the run page", async () => {
    const { response } = await launch({ brief: "x", humanApproval: true });
    expect(response.status).toBe(202);

    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    expect(page.contexts[0]?.state.kind).toBe("awaiting_approval");
  });

  it("launches a workflow whose context's result waits for a person's approval", async () => {
    const response = await routes.launchWorkflow(
      request(
        {
          title: "Reviewed",
          contexts: [{ key: "a", brief: "A", humanApproval: true }],
        },
        identity("owner-1"),
      ),
      params(),
    );
    expect(response.status).toBe(202);
    await quiesce(supervision);

    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    expect(page.contexts[0]?.state.kind).toBe("awaiting_approval");
  });

  it("lets a person read and steer a run beside its owner, and records who acted", async () => {
    h.script = () => new Promise(() => {});
    await routes.launch(
      request({ brief: "Long work" }, identity("owner-1")),
      params(),
    );
    await quiesce(supervision, false);
    const asPerson = (body: unknown) =>
      routes.control(request(body, {}), params({ runId: "run-1" }));

    expect((await asPerson({ action: "pause" })).status).toBe(200);
    expect(supervision.runs.observe("run-1")?.record.progress.kind).toBe(
      "paused",
    );
    // Its context's turn finishes under the pause; nothing after it starts.
    const paused = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    expect(paused.contexts[0]?.state).toEqual({
      kind: "paused",
      next: { kind: "work", reason: "initial" },
      draining: true,
    });
    // The seat's first conversation is its current one, before any turn settles.
    expect(
      paused.contexts[0]?.agents.map((agent) => [
        agent.assignment,
        agent.status,
      ]),
    ).toEqual([["implementer", "idle"]]);
    // An agent credential never stands for a person: another conversation is still refused.
    const byOther = await routes.control(
      request(
        { action: "resume" },
        { authorization: "Bearer test", ...identity("other-1") },
      ),
      params({ runId: "run-1" }),
    );
    expect(byOther.status).toBe(403);
    tokenValid = false;
    const forged = await routes.control(
      request({ action: "resume" }, { authorization: "Bearer wrong" }),
      params({ runId: "run-1" }),
    );
    expect(forged.status).toBe(401);
    tokenValid = true;
    const byOwner = await routes.control(
      request({ action: "resume" }, identity("owner-1")),
      params({ runId: "run-1" }),
    );
    expect(byOwner.status).toBe(200);
    expect((await asPerson({ action: "cancel" })).status).toBe(200);
    expect(
      supervision.runs
        .observe("run-1")
        ?.record.facts.acts.map((act) => [act.action, act.by]),
    ).toEqual([
      ["pause", "person"],
      ["resume", "owner"],
      ["cancel", "person"],
    ]);

    const shown = await routes.show(
      request(null, {}, "GET"),
      params({ runId: "run-1" }),
    );
    expect(shown.status).toBe(200);
    const view = runViewSchema.parse(await json(shown));
    expect(view.acts.map((act) => [act.action, act.by])).toEqual([
      ["pause", "person"],
      ["resume", "owner"],
      ["cancel", "person"],
    ]);
    const definition = await routes.definition(
      request(null, {}, "GET"),
      params({ runId: "run-1" }),
    );
    expect(definition.status).toBe(200);

    await quiesce(supervision, false);
    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    expect(
      page.activity
        .filter(
          (event) => event.kind !== "started" && event.kind !== "launched",
        )
        .map((event) => [event.kind, event.summary]),
    ).toEqual([
      ["paused", "Paused by Alex"],
      ["resumed", "Resumed by the owner"],
      ["cancelled", "Cancelled by Alex"],
    ]);
  });

  it("says a run's cost is incomplete once a seat's conversation is gone, rather than counting it as nothing", async () => {
    await launch({ brief: "First" });
    deleted.add("conv-1");

    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-1" })),
      ),
    );
    const [context] = page.contexts;
    expect(context?.agents).toEqual([
      expect.objectContaining({
        conversationId: "conv-1",
        turns: null,
        costUsd: null,
      }),
    ]);
    expect([context?.costUsd, context?.costComplete]).toEqual([0, false]);
    expect([page.costUsd, page.costComplete]).toEqual([0, false]);
    const [summary] = z
      .array(runSummarySchema)
      .parse(await json(await routes.list(request(null, {}, "GET"), params())));
    expect(summary?.costComplete).toBe(false);
  });

  it("lists the session's runs for a person, newest first, with their progress, attention and cost", async () => {
    await launch({ brief: "First" });
    await launch({ brief: "Second" });

    const listed = await routes.list(request(null, {}, "GET"), params());
    expect(listed.status).toBe(200);
    const runs = z.array(runSummarySchema).parse(await json(listed));
    expect(
      runs.map((run) => [
        run.runId,
        run.status.kind,
        run.contexts,
        run.attention,
        run.costUsd,
      ]),
    ).toEqual([
      ["run-2", "succeeded", { done: 1, total: 1 }, 0, 0.25],
      ["run-1", "succeeded", { done: 1, total: 1 }, 0, 0.25],
    ]);
    expect(runs[0]?.owner).toEqual({
      conversationId: "owner-1",
      title: "Owner one",
      backend: "claude",
    });
    expect(runs[0]?.finishedAt).not.toBeNull();
  });

  it("shows a person the run page: each context's state and stages, edges, documents with their text, charter and activity", async () => {
    await routes.launchWorkflow(
      request(
        {
          title: "Plan then build",
          contexts: [
            { key: "plan", brief: "Plan it" },
            { key: "build", brief: "Build it", dependsOn: ["plan"] },
          ],
          documents: [
            { path: "notes.md", contents: "Notes", description: "Notes" },
          ],
          charter: { mission: "Ship" },
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    const shown = await routes.page(
      request(null, {}, "GET"),
      params({ runId: "run-1" }),
    );
    expect(shown.status).toBe(200);
    const page = runPageSchema.parse(await json(shown));
    expect(page.status).toEqual({ kind: "succeeded" });
    expect(page.owner.title).toBe("Owner one");
    expect(
      page.contexts.map((c) => [c.key, c.state.kind, c.invocationId]),
    ).toEqual([
      ["plan", "succeeded", "run-1.plan"],
      ["build", "succeeded", "run-1.build"],
    ]);
    expect(page.contexts[1]?.stages.map((s) => s.state)).toEqual([
      "done",
      "done",
      "done",
      "skipped",
      "done",
    ]);
    expect(page.contexts[1]?.agents).toEqual([
      expect.objectContaining({
        assignment: "implementer",
        status: "finished",
        costUsd: 0.25,
      }),
    ]);
    expect(page.costUsd).toBe(0.5);
    expect(page.edges).toEqual([
      { from: "plan", to: "build", guard: null, outputOnly: false },
    ]);
    expect(page.documents).toEqual([
      expect.objectContaining({
        path: "notes.md",
        revision: 1,
        contents: "Notes",
      }),
    ]);
    expect(page.charter).toMatchObject({ revision: 1, mission: "Ship" });
    expect(
      page.activity.map((event) => [event.kind, event.contextKey ?? null]),
    ).toEqual([
      ["launched", null],
      ["started", "plan"],
      ["succeeded", "plan"],
      ["started", "build"],
      ["succeeded", "build"],
      ["succeeded", null],
    ]);
    // A context's events name it by key; the run's own are worded for the person, not the owner.
    expect(page.activity.map((event) => event.summary)).toEqual([
      "Launched",
      "started",
      "finished",
      "started",
      "finished",
      "Finished",
    ]);
    // Each event keeps an identity from the fact it comes from, whatever lands before it later.
    expect(page.activity.map((event) => event.id)).toEqual([
      "launch",
      "start:run-1.plan",
      "done:run-1.plan",
      "start:run-1.build",
      "done:run-1.build",
      expect.stringMatching(/^boundary:\d+$/),
    ]);
    expect(page.definition).toMatchObject({ title: "Plan then build" });
  });

  it("shows a result awaiting approval with what its candidate changed, as something a person must decide", async () => {
    await supervision.runs.launch({
      runId: "run-9",
      cause: "launch-run-9",
      kind: "agent",
      title: "Needs approval",
      projectPath: "/repo",
      sessionName: "session",
      owner: { conversationId: "owner-1", sessionName: "session" },
      contexts: [
        {
          key: "agent",
          dependsOn: [],
          request: agentStartRequest("run-9", { humanApproval: true }),
        },
      ],
    });
    await quiesce(supervision);

    const page = runPageSchema.parse(
      await json(
        await routes.page(request(null, {}, "GET"), params({ runId: "run-9" })),
      ),
    );

    const [context] = page.contexts;
    expect(context?.state.kind).toBe("awaiting_approval");
    expect(context?.candidate).toEqual({
      status: "ready",
      scope: "whole_tree",
      ownedPaths: [],
      diff: { files: [], totalAdditions: 3, totalDeletions: 1 },
    });
    expect(diffed).toEqual([
      {
        worktreePath: "/repo/.worktrees/session",
        evidence: expect.stringMatching(/^git:/),
      },
    ]);
    expect(page.attention).toEqual([
      expect.objectContaining({ kind: "approval", contextKey: "agent" }),
    ]);
    expect(page.status).toEqual({ kind: "needs_input" });
  });

  it("lets only a person, never an agent, decide a result awaiting human approval", async () => {
    await supervision.runs.launch({
      runId: "run-9",
      cause: "launch-run-9",
      kind: "agent",
      title: "Needs approval",
      projectPath: "/repo",
      sessionName: "session",
      owner: { conversationId: "owner-1", sessionName: "session" },
      contexts: [
        {
          key: "agent",
          dependsOn: [],
          request: agentStartRequest("run-9", { humanApproval: true }),
        },
      ],
    });
    await quiesce(supervision);
    const approval = h.recorded.find((b) => b.kind === "approval");
    const detail = approval?.detail as {
      contextId: string;
      candidateId: string;
    };
    const decision = {
      contextId: detail.contextId,
      candidateId: detail.candidateId,
      decision: "approved",
    };

    const byAgent = await routes.decide(
      request(decision, {
        authorization: "Bearer test",
        ...identity("owner-1"),
      }),
      params({ runId: "run-9" }),
    );
    expect(byAgent.status).toBe(403);
    expect(await json(byAgent)).toMatchObject({
      code: "human_decision_required",
    });
    await quiesce(supervision);
    expect(supervision.runs.observe("run-9")?.record.progress.kind).toBe(
      "needs_owner",
    );

    const byPerson = await routes.decide(
      request(decision, {}),
      params({ runId: "run-9" }),
    );
    expect(byPerson.status).toBe(200);
    await quiesce(supervision);
    expect(supervision.runs.observe("run-9")?.record.progress).toEqual({
      kind: "succeeded",
    });
  });

  it("lets only the owner amend a workflow, running a halted loop further, and names each change started work forbids", async () => {
    h.script = async () => ({
      ...done("Reviewed."),
      structuredOutput: { approved: false },
    });
    const polish = (maxPasses: number, implementBrief = "Implement it") => ({
      title: "Polish",
      contexts: [
        { key: "implement", brief: implementBrief },
        {
          key: "review",
          brief: "Review it",
          dependsOn: ["implement"],
          outputSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
          },
        },
      ],
      loops: [
        {
          key: "polish",
          body: ["implement", "review"],
          entry: "implement",
          exit: "review",
          until: {
            schema: {
              type: "object",
              properties: { approved: { const: true } },
            },
          },
          maxPasses,
        },
      ],
    });
    await routes.launchWorkflow(
      request(polish(1), identity("owner-1")),
      params(),
    );
    await quiesce(supervision);
    const amend = (body: unknown, caller = "owner-1") =>
      routes.amend(request(body, identity(caller)), params({ runId: "run-1" }));

    const byOther = await amend({ definition: polish(2) }, "other-1");
    expect(byOther.status).toBe(403);

    const readDefinition = async () =>
      json(
        await routes.definition(
          request(null, identity("owner-1"), "GET"),
          params({ runId: "run-1" }),
        ),
      );
    expect(await readDefinition()).toEqual({
      runId: "run-1",
      revision: 1,
      definition: polish(1),
    });

    const amended = await amend({ definition: polish(2), basedOn: 1 });
    expect(amended.status).toBe(200);
    expect(await json(amended)).toMatchObject({ ok: true, revision: 2 });
    expect(await readDefinition()).toEqual({
      runId: "run-1",
      revision: 2,
      definition: polish(2),
    });
    await quiesce(supervision);
    const view = await json(
      await routes.show(
        request(null, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    expect(view.loops).toEqual([
      { key: "polish", pass: 2, maxPasses: 2, state: "exhausted" },
    ]);
    expect(view.definitionRevision).toBe(2);

    const refused = await amend({
      definition: polish(1, "Implement it differently"),
    });
    expect(refused.status).toBe(409);
    expect(await json(refused)).toMatchObject({
      code: "amendment_refused",
      issues: [
        {
          path: "definition",
          message: expect.stringContaining('"implement" has started'),
        },
        {
          path: "definition",
          message: expect.stringContaining('loop "polish"'),
        },
      ],
    });
  });

  it("freezes a workflow's charter for each context, which reads the part meant for it beside its documents", async () => {
    const launched = await routes.launchWorkflow(
      request(
        {
          title: "Charted",
          contexts: [{ key: "build", brief: "Build it" }],
          charter: {
            mission: "Ship",
            invariants: [{ id: "no-mocks", statement: "No internal mocks" }],
          },
        },
        identity("owner-1"),
      ),
      params(),
    );
    expect(launched.status).toBe(202);
    await quiesce(supervision);

    const contextId =
      supervision.runs.observe("run-1")?.record.facts.invocations[0]
        ?.contextId ?? "";
    const contract =
      supervision.contexts.observe(contextId)?.record.facts.contract.current;
    expect(contract?.charter).toMatchObject({
      mission: "Ship",
      invariants: [{ id: "no-mocks", statement: "No internal mocks" }],
    });
    expect(contract?.documents.map((d) => [d.path, d.artifactId])).toEqual([
      [`.cc/run-docs/${contextId}/charter.md`, "sha256:Ship"],
    ]);
  });

  it("freezes a workflow's documents again when it is amended, for the work that has not started", async () => {
    h.script = async () => ({
      ...done("Reviewed."),
      structuredOutput: { approved: false },
    });
    const polish = (maxPasses: number, plan: string) => ({
      title: "Polish",
      contexts: [
        { key: "implement", brief: "Implement it" },
        {
          key: "review",
          brief: "Review it",
          dependsOn: ["implement"],
          outputSchema: {
            type: "object",
            properties: { approved: { type: "boolean" } },
            required: ["approved"],
          },
        },
      ],
      loops: [
        {
          key: "polish",
          body: ["implement", "review"],
          entry: "implement",
          exit: "review",
          until: {
            schema: {
              type: "object",
              properties: { approved: { const: true } },
            },
          },
          maxPasses,
        },
      ],
      documents: [{ path: "plan.md", contents: plan, description: "The plan" }],
      charter: { mission: `Polish ${plan}` },
    });
    await routes.launchWorkflow(
      request(polish(1, "v1"), identity("owner-1")),
      params(),
    );
    await quiesce(supervision);

    const amended = await routes.amend(
      request(
        { definition: polish(2, "v2"), basedOn: 1, reason: "The plan changed" },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(amended.status).toBe(200);
    await quiesce(supervision);

    expect(snapshots).toHaveLength(2);
    const record = supervision.runs.observe("run-1")?.record;
    expect(
      record?.facts.documents.map((r) => [
        r.revision,
        r.source,
        r.document?.artifactId,
      ]),
    ).toEqual([
      [1, "launch", "sha256:v1"],
      [2, "amend", "sha256:v2"],
    ]);
    expect(
      record?.facts.charter.map((r) => [
        r.revision,
        r.source,
        r.charter?.mission,
        r.reason,
      ]),
    ).toEqual([
      [1, "launch", "Polish v1", null],
      [2, "amend", "Polish v2", "The plan changed"],
    ]);
    const planOf = (contextId: string | undefined) =>
      supervision.contexts
        .observe(contextId ?? "")
        ?.record.facts.contract.current.documents.find((d) =>
          d.path.endsWith("/plan.md"),
        )?.artifactId;
    const passes =
      record?.facts.invocations.filter((i) => i.key === "implement") ?? [];
    expect(passes.map((i) => planOf(i.contextId))).toEqual([
      "sha256:v1",
      "sha256:v2",
    ]);
  });

  it("reports a refusal as a conflict even when it comes from another copy of the run module, as the boot-time supervision is", async () => {
    // A server can load the Run module once for boot and again for a route, so the refusal's class is not the route's.
    class RunControlRefusedError extends Error {
      override name = "RunControlRefusedError";
    }
    class RunAmendmentRefusedError extends Error {
      override name = "RunAmendmentRefusedError";
      constructor(readonly issues: string[]) {
        super(issues.join("; "));
      }
    }
    await launch();
    const real = supervision;
    supervision = {
      ...real,
      runs: {
        ...real.runs,
        async retryLane() {
          throw new RunControlRefusedError('Run run-1 has no lane "nope"');
        },
        async amend() {
          throw new RunAmendmentRefusedError(['"agent" has started']);
        },
      },
    };
    const retry = await routes.control(
      request({ action: "retry", lane: "nope" }, identity("owner-1")),
      params({ runId: "run-1" }),
    );
    expect(retry.status).toBe(409);
    expect(await json(retry)).toMatchObject({ code: "run_control_refused" });
    const amended = await routes.amend(
      request(
        {
          definition: {
            title: "Again",
            contexts: [{ key: "agent", brief: "Fix it" }],
          },
        },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(amended.status).toBe(409);
    expect(await json(amended)).toMatchObject({
      code: "amendment_refused",
      issues: [{ path: "definition", message: '"agent" has started' }],
    });
  });

  it("amends a run whose started context's backend is no longer available: started work is not admitted again", async () => {
    h.script = () => new Promise(() => {});
    const chain = (docsBrief: string) => ({
      title: "Chain",
      contexts: [
        { key: "api", brief: "Build it", backend: "codex" },
        { key: "docs", brief: docsBrief, dependsOn: ["api"] },
      ],
    });
    await routes.launchWorkflow(
      request(chain("Document it"), identity("owner-1")),
      params(),
    );
    await quiesce(supervision, false);
    expect(
      supervision.runs
        .observe("run-1")
        ?.record.facts.invocations.map((i) => i.key),
    ).toEqual(["api"]);
    codexWithdrawn = true;

    const amended = await routes.amend(
      request(
        { definition: chain("Document the routes") },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(await json(amended)).toMatchObject({ ok: true, revision: 2 });
  });

  it("refuses adding a reviewer to a started context as a change to started work, not as a server error", async () => {
    h.script = () => new Promise(() => {});
    const chain = (reviewers: Array<{ authority: "blocking" }>) => ({
      title: "Chain",
      contexts: [
        {
          key: "api",
          brief: "Build it",
          ...(reviewers.length > 0 ? { reviewers } : {}),
        },
        { key: "docs", brief: "Document it", dependsOn: ["api"] },
      ],
    });
    await routes.launchWorkflow(
      request(chain([]), identity("owner-1")),
      params(),
    );
    await quiesce(supervision, false);

    const amended = await routes.amend(
      request(
        { definition: chain([{ authority: "blocking" }]) },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(amended.status).toBe(409);
    expect(await json(amended)).toMatchObject({
      code: "amendment_refused",
      issues: [
        {
          path: "definition",
          message: expect.stringContaining('"api" has started'),
        },
      ],
    });
    expect(
      supervision.runs.observe("run-1")?.record.facts.definition.revision,
    ).toBe(1);
  });

  it("keeps a run's lanes where they are when the branch prefix changed after launch", async () => {
    // The lane's context starts, and its turn stays open, before the branch prefix changes.
    h.laneGit.state.heads.set("csm/session", "h0");
    h.script = () => new Promise(() => {});
    const laned = {
      title: "Laned",
      contexts: [{ key: "api", brief: "Build it", lane: "api" }],
    };
    await routes.launchWorkflow(request(laned, identity("owner-1")), params());
    await quiesce(supervision, false);
    expect(
      supervision.runs
        .observe("run-1")
        ?.record.facts.invocations.map((i) => i.key),
    ).toEqual(["api"]);
    const launchedLane =
      supervision.runs.observe("run-1")?.record.facts.definition.lanes?.[0];
    branchPrefix = "team";
    const amended = await routes.amend(
      request(
        { definition: { ...laned, title: "Laned again" } },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(await json(amended)).toMatchObject({ ok: true, revision: 2 });
    expect(
      supervision.runs.observe("run-1")?.record.facts.definition.lanes?.[0],
    ).toEqual(launchedLane);
  });

  it("records a seat's task commands only for the seat's own context", async () => {
    let commandResult: Response | null = null;
    h.script = async (input) => {
      commandResult = await routes.tasks(
        request(
          { kind: "complete", taskId: "t1" },
          identity(input.conversationId),
        ),
        params(),
      );
      return done("Finished the route.");
    };
    await launch({ brief: "Add the route", tasks: [{ title: "Route" }] });

    const result = commandResult as Response | null;
    expect(result?.status).toBe(200);
    expect(supervision.runs.observe("run-1")?.record.progress).toEqual({
      kind: "succeeded",
    });
    const refused = await routes.tasks(
      request({ kind: "complete", taskId: "t1" }, identity("owner-1")),
      params(),
    );
    expect(refused.status).toBe(403);
  });
});

describe("published documents", () => {
  const publish = async (
    body: Record<string, unknown>,
    conversationId: string,
  ) => {
    const response = await routes.publishDocument(
      request(body, identity(conversationId)),
      params(),
    );
    return { status: response.status, ...(await json(response)) };
  };

  it("publishes a seat's file as a new revision: work that starts later freezes it, the publisher keeps what it froze", async () => {
    seatFiles = { "docs/plan.md": "v2", "notes/api.md": "endpoints" };
    const published: Array<Record<string, unknown>> = [];
    h.script = async (input) => {
      if (published.length === 0) {
        published.push(
          await publish(
            { file: "docs/plan.md", as: "plan.md" },
            input.conversationId,
          ),
        );
        published.push(
          await publish(
            { file: "notes/api.md", description: "The API's endpoints" },
            input.conversationId,
          ),
        );
      }
      return done("Done.");
    };
    await routes.launchWorkflow(
      request(
        {
          title: "API then docs",
          contexts: [
            { key: "api", brief: "Build the API" },
            { key: "docs", brief: "Document it", dependsOn: ["api"] },
          ],
          documents: [
            { path: "plan.md", contents: "v1", description: "The plan" },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    expect(published).toEqual([
      {
        status: 200,
        ok: true,
        runId: "run-1",
        path: "plan.md",
        revision: 2,
        unchanged: false,
      },
      {
        status: 200,
        ok: true,
        runId: "run-1",
        path: "notes/api.md",
        revision: 1,
        unchanged: false,
      },
    ]);
    expect(seatReads).toEqual([
      "/repo/.worktrees/session",
      "/repo/.worktrees/session",
    ]);
    const record = supervision.runs.observe("run-1")?.record;
    const [api, docs] = record?.facts.invocations ?? [];
    const frozen = (contextId: string | undefined) =>
      supervision.contexts
        .observe(contextId ?? "")
        ?.record.facts.contract.current.documents.map((d) => [
          d.path,
          d.artifactId,
        ]);
    expect(frozen(api?.contextId)).toEqual([
      [`.cc/run-docs/${api?.contextId}/plan.md`, "sha256:v1"],
    ]);
    expect(frozen(docs?.contextId)).toEqual([
      [`.cc/run-docs/${docs?.contextId}/plan.md`, "sha256:v2"],
      [`.cc/run-docs/${docs?.contextId}/notes/api.md`, "sha256:endpoints"],
    ]);
    expect(record?.facts.documents.at(-1)).toMatchObject({
      path: "notes/api.md",
      source: "publish",
      by: api?.contextId,
    });

    const view = runViewSchema.parse(
      await json(
        await routes.show(
          request(undefined, identity("owner-1"), "GET"),
          params({ runId: "run-1" }),
        ),
      ),
    );
    expect(view.contexts.map((c) => [c.key, c.froze])).toEqual([
      ["api", { charter: null, documents: [{ path: "plan.md", revision: 1 }] }],
      [
        "docs",
        {
          charter: null,
          documents: [
            { path: "plan.md", revision: 2 },
            { path: "notes/api.md", revision: 1 },
          ],
        },
      ],
    ]);
  });

  it("refuses a publication from anyone but a workflow context's current implementer, or one a declaration could not make", async () => {
    seatFiles = { "notes.md": "n" };
    expect(
      (await publish({ file: "notes.md", description: "N" }, "owner-1")).status,
    ).toBe(403);

    let agentSeat: Record<string, unknown> = {};
    h.script = async (input) => {
      agentSeat = await publish(
        { file: "notes.md", description: "N" },
        input.conversationId,
      );
      return done("Done.");
    };
    await launch();
    expect(agentSeat).toMatchObject({
      status: 409,
      error: expect.stringContaining("workflow"),
    });

    const refusals: Array<Record<string, unknown>> = [];
    h.script = async (input) => {
      if (refusals.length === 0)
        for (const body of [
          { file: "missing.md", description: "M" },
          { file: "notes.md", as: "charter.md/notes.md", description: "N" },
          { file: "notes.md", as: "Plan.md", description: "N" },
        ])
          refusals.push(await publish(body, input.conversationId));
      return done("Done.");
    };
    await routes.launchWorkflow(
      request(
        {
          title: "One",
          contexts: [{ key: "only", brief: "Do it" }],
          documents: [
            { path: "plan.md", contents: "v1", description: "The plan" },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    expect(refusals).toEqual([
      expect.objectContaining({
        status: 400,
        error: expect.stringContaining("No file"),
      }),
      expect.objectContaining({
        status: 409,
        error: expect.stringContaining("reserved for the run's charter"),
      }),
      expect.objectContaining({
        status: 409,
        error: expect.stringContaining("only by case"),
      }),
    ]);
    expect(
      supervision.runs
        .observe("run-2")
        ?.record.facts.documents.map((r) => [r.path, r.revision]),
    ).toEqual([["plan.md", 1]]);
  });

  it("shows the run's current documents in its definition, so an amendment keeps a published revision by naming it", async () => {
    seatFiles = { "plan.md": "v2", "notes.md": "n" };
    let published = false;
    h.script = async (input) => {
      if (!published) {
        published = true;
        await publish({ file: "plan.md" }, input.conversationId);
        await publish(
          { file: "notes.md", description: "Notes" },
          input.conversationId,
        );
        return done("Done.");
      }
      return new Promise(() => {});
    };
    await routes.launchWorkflow(
      request(
        {
          title: "API then docs",
          contexts: [
            { key: "api", brief: "Build the API" },
            { key: "docs", brief: "Document it", dependsOn: ["api"] },
          ],
          documents: [
            { path: "plan.md", contents: "v1", description: "The plan" },
            { path: "glossary.md", contents: "terms", description: "Terms" },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision, false);

    const read = await json(
      await routes.definition(
        request(undefined, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    const definition = read.definition as Record<string, unknown>;
    expect(definition.documents).toEqual([
      { path: "plan.md", revision: 2, description: "The plan" },
      { path: "glossary.md", revision: 1, description: "Terms" },
      { path: "notes.md", revision: 1, description: "Notes" },
    ]);
    // Inline contents are frozen once; the run record does not carry them.
    expect(
      supervision.runs.observe("run-1")?.record.facts.definition.authored
        ?.documents,
    ).toBeUndefined();

    const amended = await routes.amend(
      request(
        {
          definition: {
            ...definition,
            contexts: [
              ...(definition.contexts as unknown[]),
              { key: "extra", brief: "More", dependsOn: ["docs"] },
            ],
            documents: (definition.documents as Array<{ path: string }>).filter(
              (d) => d.path !== "glossary.md",
            ),
          },
          basedOn: read.revision,
          reason: "The glossary moved",
        },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    const amendedBody = await json(amended);
    expect(amended.status, JSON.stringify(amendedBody)).toBe(200);
    expect(amendedBody).toMatchObject({ removedDocuments: ["glossary.md"] });
    expect(
      supervision.runs
        .observe("run-1")
        ?.record.facts.documents.map((r) => [
          r.path,
          r.revision,
          r.source,
          r.reason ?? null,
        ]),
    ).toEqual([
      ["plan.md", 1, "launch", null],
      ["glossary.md", 1, "launch", null],
      ["plan.md", 2, "publish", null],
      ["notes.md", 1, "publish", null],
      ["glossary.md", 2, "amend", "The glossary moved"],
    ]);

    const stale = await routes.amend(
      request(
        {
          definition: {
            ...definition,
            documents: [
              { path: "plan.md", revision: 1, description: "The plan" },
            ],
          },
        },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    expect(stale.status).toBe(400);
    expect(await json(stale)).toMatchObject({
      issues: [{ path: "documents.0.revision" }],
    });
  });

  it("refuses a publication whose context finished while its file was being frozen", async () => {
    seatFiles = { "notes.md": "n" };
    const held = hold();
    holdSeatFile = held.wait;
    const pending: Array<Promise<Record<string, unknown>>> = [];
    h.script = async (input) => {
      if (pending.length > 0) return new Promise(() => {});
      pending.push(
        publish(
          { file: "notes.md", description: "Notes" },
          input.conversationId,
        ),
      );
      return done("Done.");
    };
    await routes.launchWorkflow(
      request(
        {
          title: "API then docs",
          contexts: [
            { key: "api", brief: "Build the API" },
            { key: "docs", brief: "Document it", dependsOn: ["api"] },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision, false);
    const api = supervision.runs.observe("run-1")?.record.facts.invocations[0];
    expect(
      supervision.contexts.observe(api?.contextId ?? "")?.record.progress.kind,
    ).toBe("succeeded");

    held.release();
    expect(await pending[0]).toMatchObject({
      status: 409,
      error: expect.stringContaining("has finished"),
    });
    expect(supervision.runs.observe("run-1")?.record.facts.documents).toEqual(
      [],
    );
  });

  it("names every document an amendment removed, even one published while the amendment was being prepared", async () => {
    seatFiles = { "late.md": "late" };
    const later: Array<() => Promise<Record<string, unknown>>> = [];
    h.script = async (input) => {
      later.push(() =>
        publish(
          { file: "late.md", description: "Late notes" },
          input.conversationId,
        ),
      );
      return new Promise(() => {});
    };
    await routes.launchWorkflow(
      request(
        {
          title: "API",
          contexts: [{ key: "api", brief: "Build the API" }],
          documents: [
            { path: "plan.md", contents: "v1", description: "The plan" },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision, false);
    const read = await json(
      await routes.definition(
        request(undefined, identity("owner-1"), "GET"),
        params({ runId: "run-1" }),
      ),
    );
    const definition = read.definition as Record<string, unknown>;

    const held = hold();
    holdDocuments = held.wait;
    const amending = routes.amend(
      request(
        {
          definition: {
            ...definition,
            contexts: [
              ...(definition.contexts as unknown[]),
              { key: "extra", brief: "More", dependsOn: ["api"] },
            ],
          },
          basedOn: read.revision,
        },
        identity("owner-1"),
      ),
      params({ runId: "run-1" }),
    );
    await held.reached;
    expect(await later[0]?.()).toMatchObject({
      status: 200,
      path: "late.md",
      revision: 1,
    });
    held.release();

    const amended = await amending;
    expect(amended.status).toBe(200);
    expect(await json(amended)).toMatchObject({
      removedDocuments: ["late.md"],
    });
  });

  it("refuses a publication over a revision another context published after the publisher started", async () => {
    seatFiles = { "a.md": "from a", "b.md": "from b" };
    const outcomes: Record<string, Record<string, unknown>> = {};
    let alphaDone = () => {};
    const alphaPublished = new Promise<void>((resolve) => {
      alphaDone = resolve;
    });
    h.script = async (input) => {
      if (input.request.message.includes("Alpha")) {
        outcomes.alpha = await publish(
          { file: "a.md", as: "plan.md" },
          input.conversationId,
        );
        alphaDone();
      } else {
        await alphaPublished;
        outcomes.beta = await publish(
          { file: "b.md", as: "plan.md" },
          input.conversationId,
        );
      }
      return done("Done.");
    };
    await routes.launchWorkflow(
      request(
        {
          title: "Side by side",
          contexts: [
            {
              key: "alpha",
              brief: "Alpha work",
              scope: { mode: "owned", paths: ["src/a"] },
            },
            {
              key: "beta",
              brief: "Beta work",
              scope: { mode: "owned", paths: ["src/b"] },
            },
          ],
          documents: [
            { path: "plan.md", contents: "v1", description: "The plan" },
          ],
        },
        identity("owner-1"),
      ),
      params(),
    );
    await quiesce(supervision);

    expect(outcomes.alpha).toMatchObject({ status: 200, revision: 2 });
    expect(outcomes.beta).toMatchObject({
      status: 409,
      error: expect.stringMatching(
        /plan\.md is at revision 2, published by run-1\.alpha after you started from revision 1/,
      ),
    });
  });
});
