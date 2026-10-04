import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextResponse } from "next/server";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { createRunRouteHandlers, type RunRouteDeps } from "./route-handlers";
import { runViewSchema } from "./schemas";
import type { RunSupervision } from "./supervision";
import {
  agentStartRequest,
  createSupervisionHarness,
  done,
  quiesce,
} from "./testing/supervision-fixture";

let fixture: PersistenceFixture;
let h: ReturnType<typeof createSupervisionHarness>;
let supervision: RunSupervision;
let sessionConversations: string[];
let routes: ReturnType<typeof createRunRouteHandlers>;
let tokenValid: boolean;

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
    async getSession(_projectPath, sessionName) {
      if (sessionName === "session-2") {
        return {
          sessionName,
          worktreePath: "/repo/.worktrees/session-2",
          conversations: [{ id: "s2-conv" }],
        };
      }
      if (sessionName !== "session") return null;
      return {
        sessionName,
        worktreePath: "/repo/.worktrees/session",
        conversations: [
          ...sessionConversations.map((id) => ({ id })),
          ...Object.values(supervisionSeats()).map((id) => ({ id })),
        ],
      };
    },
    supervision: () => supervision,
    async resolveSeats({ request: launchRequest }) {
      const seat = {
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
    const response = await routes.launch(request({ brief: "Nested work" }, identity("conv-1")), params());
    expect(response.status).toBe(403);
    expect(await json(response)).toMatchObject({ code: "seat_cannot_launch" });
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

  it("pauses, resumes and cancels a run for its owner only", async () => {
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

  it("refuses human approval at agent launch until a person can decide it", async () => {
    const response = await routes.launch(
      request({ brief: "x", humanApproval: true }, identity("owner-1")),
      params(),
    );
    expect(response.status).toBe(400);
    expect(await json(response)).toMatchObject({
      code: "human_approval_unavailable",
    });
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
      invocations: [
        {
          key: "agent",
          request: agentStartRequest("run-9", { humanApproval: true }),
        },
      ],
    });
    await quiesce(supervision);
    const approval = h.notified.find((b) => b.kind === "approval");
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
