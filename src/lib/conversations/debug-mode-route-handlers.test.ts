import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BACKGROUND_WORK_RUNNING } from "@/lib/conversation-core/executor";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { createDebugAdapter } from "@/lib/workflows/conversation/debug-adapter";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";

import {
  createDebugModeHandler,
  createDebugModeRecordingHandler,
} from "./debug-mode-route-handlers";

it("returns immediately readable recording state through the durable command owner", async () => {
  const fixture = await createLifecycleFixture();
  try {
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.manager.executeConversationCommand(fixture.binding.address, {
      kind: "enter",
      debugSessionId: "recording-route",
      logFilePath: "/debug/log",
    });
    const handler = createDebugModeRecordingHandler({
      resolveProjectPath: async () => fixture.identity.projectPath,
      getSession: fixture.persistence.store.getSession,
      ensureConversation: () =>
        fixture.manager.ensureConversationLifecycle(fixture.binding),
      setRecording: (_target, recording) =>
        fixture.manager.executeConversationCommand(fixture.binding.address, {
          kind: "set_recording",
          recording,
        }),
    });
    const request = () =>
      new Request("http://localhost/debug-mode/recording", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ recording: false }),
      });
    const context = {
      params: Promise.resolve({
        name: fixture.projectName,
        session: fixture.identity.sessionName,
        conversationId: fixture.identity.conversationId,
      }),
    };
    expect((await handler(request(), context)).status).toBe(200);
    expect(
      (
        await fixture.persistence.store.getConversation(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
      )?.debugMode?.recording,
    ).toBe(false);
    expect((await handler(request(), context)).status).toBe(200);
  } finally {
    await fixture.close();
  }
});

it("answers a refused debug command with the reason its owner gave, as a conflict", async () => {
  const persistence = createPersistenceFixture();
  const worktree = mkdtempSync(path.join(tmpdir(), "cc-debug-route-wt-"));
  try {
    persistence.seedProject("/repo");
    persistence.seedSession("/repo", "s", { worktreePath: worktree });
    await persistence.seedConversation(
      "/repo",
      "s",
      makeConversationState({ id: "c" }),
    );
    const commands: string[] = [];
    const handler = createDebugModeHandler({
      resolveProjectPath: async () => "/repo",
      getSession: persistence.store.getSession,
      ensureConversation: async () => {},
      adapter: () =>
        createDebugAdapter({
          async executeCommand(_target, command) {
            commands.push(command.kind);
            return {
              kind: "refused",
              code: "busy",
              message: BACKGROUND_WORK_RUNNING,
            };
          },
        }),
    });

    const response = await handler(
      new Request("http://localhost/debug-mode", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "enter" }),
      }),
      {
        params: Promise.resolve({
          name: "repo",
          session: "s",
          conversationId: "c",
        }),
      },
    );

    expect(commands).toEqual(["enter"]);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: BACKGROUND_WORK_RUNNING });
  } finally {
    persistence.close();
    rmSync(worktree, { recursive: true, force: true });
  }
});
