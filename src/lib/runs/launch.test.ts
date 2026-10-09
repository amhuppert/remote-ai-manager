import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_POLICY } from "@/lib/execution-context/schemas";
import { agentLaunchRequestSchema, resolveAgentLaunch } from "./launch";

const sonnet = {
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};
const gpt = {
  backend: "codex" as const,
  modelSelection: { modelId: "gpt-5.4", parameters: { reasoning: "high" } },
};

function resolve(
  raw: unknown,
  reviewers: Array<typeof sonnet | typeof gpt> = [],
) {
  return resolveAgentLaunch({
    request: agentLaunchRequestSchema.parse(raw),
    runId: "run-1",
    cause: "launch-1",
    projectPath: "/repo",
    session: {
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      branch: "csm/session",
    },
    owner: { conversationId: "owner-1", sessionName: "session" },
    laneTargets: (laneId) => ({
      worktreePath: `/repo/.worktrees/session.${laneId}`,
      branch: `csm/session-${laneId}`,
    }),
    seats: { implementer: sonnet, reviewers },
  });
}

describe("agent launch resolver", () => {
  it("freezes a brief into one session-placed context with the standard agent and default policy", () => {
    const launch = resolve({
      brief: "Fix the duplicate completion notice.\nIt fires twice.",
    });

    expect(launch).toMatchObject({
      runId: "run-1",
      cause: "launch-1",
      kind: "agent",
      title: "Fix the duplicate completion notice.",
      owner: { conversationId: "owner-1", sessionName: "session" },
    });
    expect(launch.contexts).toHaveLength(1);
    const request = launch.contexts[0]?.request;
    expect(request?.workspace).toEqual({
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "full" },
    });
    expect(request?.contract).toMatchObject({
      brief: "Fix the duplicate completion notice.\nIt fires twice.",
      tasks: [],
      outputSchema: null,
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "standard-agent" },
        ...sonnet,
      },
      reviewers: [],
      checks: [],
      humanApproval: false,
      ownerQuestions: true,
    });
    expect(request?.policy).toEqual(DEFAULT_CONTEXT_POLICY);
  });

  it("carries opted-in tasks, checks, output schema, reviewers and a per-invocation timeout", () => {
    const launch = resolve(
      {
        brief: "Add the endpoint",
        title: "Endpoint",
        tasks: [
          { title: "Route" },
          { title: "Tests", instructions: "Cover refusal" },
        ],
        acceptanceCriteria: ["Refuses unknown ids"],
        checks: ["typecheck"],
        outputSchema: { type: "object" },
        reviewers: [
          { authority: "blocking", focus: "Correctness", backend: "codex" },
        ],
        humanApproval: true,
        timeoutMs: 600000,
      },
      [gpt],
    );
    const request = launch.contexts[0]?.request;

    expect(launch.title).toBe("Endpoint");
    expect(request?.contract.tasks).toEqual([
      { id: "t1", title: "Route" },
      { id: "t2", title: "Tests", instructions: "Cover refusal" },
    ]);
    expect(request?.contract.acceptanceCriteria).toEqual([
      { id: "ac-1", text: "Refuses unknown ids" },
    ]);
    expect(request?.contract.reviewers).toEqual([
      {
        id: "reviewer-1",
        authority: "blocking",
        focus: "Correctness",
        profile: { tier: "builtin", id: "general-reviewer" },
        ...gpt,
      },
    ]);
    expect(request?.contract).toMatchObject({
      checks: ["typecheck"],
      outputSchema: { type: "object" },
      humanApproval: true,
    });
    expect(request?.policy.invocationTimeoutMs).toBe(600000);
  });

  it("refuses unknown launch options rather than launching something weaker", () => {
    expect(
      agentLaunchRequestSchema.safeParse({ brief: "x", isolation: "worktree" })
        .success,
    ).toBe(false);
  });

  it("refuses a launch whose resolved reviewer seats do not match its reviewers", () => {
    expect(() =>
      resolve({ brief: "x", reviewers: [{ authority: "advisory" }] }, []),
    ).toThrow(/reviewer/);
  });
});
