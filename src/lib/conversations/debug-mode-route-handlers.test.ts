import { expect, it } from "vitest";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";

import { createDebugModeRecordingHandler } from "./debug-mode-route-handlers";

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
