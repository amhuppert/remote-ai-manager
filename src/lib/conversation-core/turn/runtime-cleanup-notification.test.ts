import { describe, expect, it, vi } from "vitest";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { ManagedConversationRuntime } from "./runtime-binding";
import {
  notifyRuntimeCleanup,
  type RuntimeCleanupNotificationDeps,
} from "./runtime-cleanup-notification";

describe("runtime cleanup notification", () => {
  it.each(["session", "project"] as const)(
    "names the affected worktree and restart gap at %s scope",
    async (scope) => {
      const target =
        scope === "session"
          ? {
              scope,
              projectName: "project",
              sessionName: "session",
              conversationId: "conversation",
            }
          : { scope, projectName: "project", conversationId: "conversation" };
      const appendNotice = vi.fn<
        RuntimeCleanupNotificationDeps["appendNotice"]
      >(async () => {});
      const push = vi.fn<RuntimeCleanupNotificationDeps["push"]>(async () => ({
        delivered: true,
      }));
      await notifyRuntimeCleanup(
        { target, worktreePath: "/workspace/session" },
        {
          appendNotice,
          push,
          log: createCapturingLogger(),
        },
      );
      expect(appendNotice).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          conversationId: "conversation",
          text: expect.stringContaining("/workspace/session"),
        }),
      );
      const notice = appendNotice.mock.calls[0]?.[0];
      expect(notice?.text).toContain("restart");
      expect(notice?.text).toContain("Inspect and stop");
      expect(push).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          target,
          urgency: "attention",
          message: notice?.text,
        }),
      );
    },
  );

  it("keeps ownership when notice and phone delivery both fail", async () => {
    const owner = new ManagedConversationRuntime("conversation");
    const failure = {
      kind: "cleanup_unverified",
      message: "inspect surviving processes",
    } as const;
    owner.recordCleanupFailure(failure);
    const log = createCapturingLogger();
    const push = vi.fn(async () => {
      throw new Error("phone unavailable");
    });
    await owner.track(
      notifyRuntimeCleanup(
        {
          target: {
            scope: "session",
            projectName: "project",
            sessionName: "session",
            conversationId: "conversation",
          },
          worktreePath: "/workspace/session",
        },
        {
          appendNotice: async () => {
            throw new Error("archive unavailable");
          },
          push,
          log,
        },
      ),
    );
    expect(push).toHaveBeenCalledTimes(1);
    expect(owner.cleanupFailure).toEqual(failure);
    expect(() => owner.beginCreation()).toThrow(failure.message);
    expect(
      log.entries.filter(
        (entry) => entry.message === "conversation.cleanup_notification_failed",
      ),
    ).toHaveLength(2);
  });
});
