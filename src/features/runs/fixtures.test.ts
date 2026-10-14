import { describe, expect, it } from "vitest";
import { z } from "zod";
import { runPageSchema, runSummarySchema } from "@/lib/runs/schemas";
import {
  compileWorkflow,
  workflowLaunchRequestSchema,
} from "@/lib/runs/workflow-definition";
import {
  checkoutRun,
  checkoutHaltedRun,
  checkoutLoopRun,
  checkoutSucceededRun,
  noticeRun,
  noticeRunAwaitingApproval,
  sessionRuns,
} from "./fixtures";

describe("run prototype evidence", () => {
  it("shows a workflow topology the real compiler admits", () => {
    const result = workflowLaunchRequestSchema.safeParse({
      title: checkoutRun.title,
      contexts: checkoutRun.contexts.map((context) => ({
        key: context.key,
        brief: context.brief,
        dependsOn: context.dependsOn.map((key) =>
          checkoutRun.edges.some(
            (edge) =>
              edge.from === key && edge.to === context.key && edge.outputOnly,
          )
            ? { key, outputOnly: true }
            : key,
        ),
        scope: context.configuration.scope,
        ...(context.placement.kind === "lane"
          ? { lane: context.placement.lane }
          : {}),
      })),
      lanes: checkoutRun.lanes.map((lane) => ({
        key: lane.key,
        checks: lane.checks,
      })),
    });
    expect(
      result.success ? [] : result.error.issues.map((issue) => issue.message),
    ).toEqual([]);
    if (!result.success) return;
    const compiled = compileWorkflow({
      request: result.data,
      runId: "ui-fixture",
      cause: "ui-fixture",
      projectPath: "/repo",
      session: {
        sessionName: "checkout",
        worktreePath: "/repo/.worktrees/checkout",
        branch: "csm/checkout",
      },
      owner: { conversationId: "owner", sessionName: "checkout" },
      laneTargets: (key) => ({
        worktreePath: `/repo/.worktrees/checkout-${key}`,
        branch: `csm/checkout-${key}`,
      }),
      validationCommands: [],
      seats: Object.fromEntries(
        result.data.contexts.map((context) => [
          context.key,
          {
            implementer: {
              backend: "claude",
              modelSelection: { modelId: "sonnet", parameters: {} },
            },
            reviewers: [],
          },
        ]),
      ),
    });
    expect(compiled.contexts).toHaveLength(checkoutRun.contexts.length);
    for (const context of compiled.contexts) {
      expect(context.request.contract.documentPublishing).toBe(true);
    }
  });

  it("keeps the authored definition and displayed dependencies consistent", () => {
    const parsed = workflowLaunchRequestSchema.safeParse(
      checkoutRun.definition,
    );
    expect(
      parsed.success ? [] : parsed.error.issues.map((issue) => issue.message),
    ).toEqual([]);
    if (!parsed.success) return;
    for (const defined of parsed.data.contexts) {
      const displayed = checkoutRun.contexts.find(
        (context) => context.key === defined.key,
      );
      expect(displayed?.dependsOn).toEqual(
        (defined.dependsOn ?? []).map((dependency) =>
          typeof dependency === "string" ? dependency : dependency.key,
        ),
      );
      expect(displayed?.configuration.scope).toEqual(defined.scope);
    }
  });

  it("never shows session writes before lane publications, and keeps task completion truthful", () => {
    for (const run of [
      checkoutRun,
      checkoutHaltedRun,
      checkoutLoopRun,
      checkoutSucceededRun,
    ]) {
      for (const context of run.contexts) {
        expect(context.tasks).toEqual({
          done: context.taskList.filter((task) => task.done).length,
          total: context.taskList.length,
        });
        if (
          context.placement.kind === "session" &&
          context.configuration.scope.mode !== "readOnly" &&
          context.startedAt !== null
        ) {
          expect(run.lanes.every((lane) => lane.state === "published")).toBe(
            true,
          );
        }
        if (context.state.kind === "succeeded") {
          expect(context.taskList.every((task) => task.done)).toBe(true);
          expect(
            context.stages.some(
              (stage) =>
                stage.state === "current" ||
                stage.state === "halted" ||
                stage.state === "waiting",
            ),
          ).toBe(false);
          expect(context.output?.status).toBe("accepted");
        }
      }
    }
  });
});

describe("fixtures as the server sends them", () => {
  it("are run pages and summaries the server's schemas accept", () => {
    for (const run of [
      checkoutRun,
      checkoutHaltedRun,
      checkoutLoopRun,
      checkoutSucceededRun,
      noticeRun,
      noticeRunAwaitingApproval,
    ]) {
      const parsed = runPageSchema.safeParse(run);
      expect(
        parsed.success ? [] : parsed.error.issues.map((issue) => issue.path),
        run.runId,
      ).toEqual([]);
    }
    expect(z.array(runSummarySchema).safeParse(sessionRuns).success).toBe(true);
  });
});
