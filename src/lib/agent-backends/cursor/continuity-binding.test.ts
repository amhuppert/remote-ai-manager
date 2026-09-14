import { describe, expect, it } from "vitest";
import { createCursorContinuityBindingResolver } from "./continuity-binding";
import { createCursorContinuityAdapter } from "./continuity";
import { createScriptedTransport } from "./testing/scripted-worker";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { storeSessionNameFromScopeRef } from "@/lib/conversations/conversation-target";
import { decodeCursorTaskRef } from "./task-ref";

const modelSelection = {
  modelId: "composer-2.5",
  parameters: { fast: "true" },
};
const context = {
  projectPath: "/repo",
  sessionName: "lane",
  conversationId: "conv-a",
  modelSelection,
};
function harness() {
  const transport = createScriptedTransport();
  const resolveBinding = createCursorContinuityBindingResolver({
    storePath: (id) => `/cc-owned/cursor/${id}`,
    getConversation: async (project, session, id) =>
      project === "/repo" && session === "lane" && id === "conv-a"
        ? { agentBackend: "cursor" }
        : null,
    getSession: async () => ({ worktreePath: "/repo/.worktrees/lane" }),
    resolveModel: async (selection) => ({ ok: true, selection }),
  });
  return {
    transport,
    adapter: createCursorContinuityAdapter({ transport, resolveBinding }),
  };
}
describe("production Cursor continuity binding", () => {
  it.each([
    null,
    {
      project: "repo",
      session: "lane",
      conversationId: "__validator__:exec:ctx:review",
    },
  ])(
    "starts and resumes a task handle in its lane cwd with scope %j",
    async (taskScope) => {
      const { transport, adapter } = harness();
      const taskContext = {
        ...context,
        conversationId: "__validator__:exec:ctx:review",
        workingDirectory: "/repo/.worktrees/lane.review",
        taskScope,
      };
      const ref = await adapter.start(taskContext);
      const task = decodeCursorTaskRef(ref);
      expect(task).toMatchObject({
        cwd: taskContext.workingDirectory,
        scope: taskContext.taskScope,
      });
      expect(await adapter.resumeOrRecover(ref, taskContext)).toEqual({
        ref,
        recovered: false,
      });
      expect(transport.startInputs).toHaveLength(2);
      for (const input of transport.startInputs) {
        expect(input.cwd).toBe(taskContext.workingDirectory);
        expect(input.storePath).toBe(`/cc-owned/cursor/task-${task.taskId}`);
      }
    },
  );
  it("resolves session and project conversations after reloading the real state store", async () => {
    const fixture = createPersistenceFixture();
    try {
      fixture.seedProject("/repo");
      fixture.seedSession("/repo", "lane", {
        worktreePath: "/repo/.worktrees/actual-cwd",
      });
      await fixture.seedConversation(
        "/repo",
        "lane",
        makeConversationState({ id: "conv-a", agentBackend: "cursor" }),
      );
      const store = fixture.recreateStore();
      const resolver = createCursorContinuityBindingResolver({
        getConversation: store.getConversation,
        getSession: store.getSession,
        storePath: (id) => `/cc/${id}`,
        resolveModel: async (selection) => ({ ok: true, selection }),
      });
      expect(await resolver(context)).toMatchObject({
        conversationId: "conv-a",
        cwd: "/repo/.worktrees/actual-cwd",
        storePath: "/cc/conv-a",
      });
      await fixture.seedProjectConversation(
        "/repo",
        makeConversationState({
          id: "project-conv",
          scope: "project",
          agentBackend: "cursor",
        }),
      );
      expect(
        await resolver({
          ...context,
          conversationId: "project-conv",
          sessionName: storeSessionNameFromScopeRef({ scope: "project" }),
        }),
      ).toMatchObject({
        conversationId: "project-conv",
        cwd: "/repo",
        storePath: "/cc/project-conv",
      });
    } finally {
      fixture.close();
    }
  });
  it("starts, validates and resumes in the persisted conversation's actual store and cwd", async () => {
    const { transport, adapter } = harness();
    const ref = await adapter.start(context);
    expect(await adapter.validate(ref, context)).toEqual({ status: "valid" });
    expect(await adapter.resumeOrRecover(ref, context)).toEqual({
      ref,
      recovered: false,
    });
    expect(transport.startInputs).toHaveLength(3);
    for (const input of transport.startInputs) {
      expect(input).toMatchObject({
        conversationId: "conv-a",
        cwd: "/repo/.worktrees/lane",
        storePath: "/cc-owned/cursor/conv-a",
        modelSelection,
      });
    }
    expect(transport.find("conv-a")).toBeNull();
  });
  it("refuses missing or foreign conversation identity before spawning", async () => {
    const { transport, adapter } = harness();
    await expect(
      adapter.start({ ...context, conversationId: "conv-b" }),
    ).rejects.toThrow(/conversation/i);
    expect(transport.workers).toHaveLength(0);
  });
});
