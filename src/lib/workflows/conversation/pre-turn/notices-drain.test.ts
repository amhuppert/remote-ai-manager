import { describe, it, expect, vi } from "vitest";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";
import type { TranscriptEntry } from "@/lib/prompt/transcript";
import {
  MAX_PENDING_AGENT_NOTICES,
  readPendingAgentNotices,
  buildPendingNoticesInstruction,
  drainConsumedAgentNotices,
  createBackgroundTasksLostHandler,
} from "./notices-drain";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const identity = {
  projectPath: "/p",
  sessionName: "s",
  conversationId: "conv-1",
};

function makeConversation(pendingAgentNotices: string[]): ConversationState {
  return conversationStateSchema.parse({
    id: "conv-1",
    transcriptPath: null,
    status: "idle",
    promptCount: 0,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    pendingAgentNotices,
  });
}

function mutateDepsOver(conversation: ConversationState) {
  return {
    mutateConversation: vi.fn(
      async (
        _p: string,
        _s: string,
        _c: string,
        _label: string,
        mutate: (c: ConversationState) => void,
      ) => {
        mutate(conversation);
      },
    ),
  };
}

describe("readPendingAgentNotices", () => {
  it("returns the conversation's pending notices", async () => {
    const deps = {
      getConversation: vi.fn(async () => makeConversation(["n1", "n2"])),
    };
    expect(await readPendingAgentNotices(deps, identity)).toEqual(["n1", "n2"]);
  });

  it("returns [] when the conversation does not exist", async () => {
    const deps = { getConversation: vi.fn(async () => null) };
    expect(await readPendingAgentNotices(deps, identity)).toEqual([]);
  });
});

describe("buildPendingNoticesInstruction", () => {
  it("lists each notice under the session-notices heading", () => {
    const instruction = buildPendingNoticesInstruction(["alpha", "beta"]);
    expect(instruction).toContain("## Session notices");
    expect(instruction).toContain("- alpha");
    expect(instruction).toContain("- beta");
  });

  it("returns null when nothing is pending", () => {
    expect(buildPendingNoticesInstruction([])).toBeNull();
  });
});

describe("drainConsumedAgentNotices", () => {
  it("removes exactly the consumed notices, preserving ones recorded in between", async () => {
    // "late" arrived after the runtime read its instructions; it must survive.
    const conversation = makeConversation(["n1", "n2", "late"]);
    const deps = mutateDepsOver(conversation);

    await drainConsumedAgentNotices(deps, identity, ["n1", "n2"]);

    expect(conversation.pendingAgentNotices).toEqual(["late"]);
  });

  it("performs no write when nothing was consumed", async () => {
    const conversation = makeConversation(["n1"]);
    const deps = mutateDepsOver(conversation);

    await drainConsumedAgentNotices(deps, identity, []);

    expect(deps.mutateConversation).not.toHaveBeenCalled();
    expect(conversation.pendingAgentNotices).toEqual(["n1"]);
  });
});

describe("createBackgroundTasksLostHandler", () => {
  const info = {
    reason: "session_closed",
    tasks: [
      { taskId: "t1", description: "watcher" },
      { taskId: "t2", description: null },
    ],
  };

  function makeHandler(
    conversation: ConversationState,
    opts?: {
      isProjectConversation?: boolean;
    },
  ) {
    const deps = mutateDepsOver(conversation);
    const appended: TranscriptEntry[] = [];
    const handler = createBackgroundTasksLostHandler(deps, {
      ...identity,
      isProjectConversation: opts?.isProjectConversation ?? false,
      appendTranscriptEntry: async (_id, entry) => {
        appended.push(entry);
      },
    });
    return { handler, deps, appended };
  }

  it("appends a visible notice row and persists a durable agent reminder", async () => {
    const conversation = makeConversation([]);
    const { handler, appended } = makeHandler(conversation);

    handler(info);
    await vi.waitFor(() => {
      expect(conversation.pendingAgentNotices).toHaveLength(1);
    });

    expect(appended).toHaveLength(1);
    expect(appended[0]?.type).toBe("notice");
    const noticeText = JSON.stringify(appended[0]?.content);
    expect(noticeText).toContain("t1 (watcher)");
    expect(noticeText).toContain("session_closed");
    expect(conversation.pendingAgentNotices[0]).toContain(
      "2 background task(s)",
    );
  });

  it("caps persisted notices at the most recent MAX_PENDING_AGENT_NOTICES", async () => {
    const existing = Array.from({ length: MAX_PENDING_AGENT_NOTICES }, (_, i) =>
      String(i),
    );
    const conversation = makeConversation(existing);
    const { handler } = makeHandler(conversation);

    handler(info);
    await vi.waitFor(() => {
      expect(conversation.pendingAgentNotices).toHaveLength(
        MAX_PENDING_AGENT_NOTICES,
      );
    });

    expect(conversation.pendingAgentNotices[0]).toBe("1");
    expect(
      conversation.pendingAgentNotices[MAX_PENDING_AGENT_NOTICES - 1],
    ).toContain("background task(s)");
  });

  it("appends the visible notice but persists no reminder for project conversations", async () => {
    const conversation = makeConversation([]);
    const { handler, deps, appended } = makeHandler(conversation, {
      isProjectConversation: true,
    });

    handler(info);
    await vi.waitFor(() => {
      expect(appended).toHaveLength(1);
    });

    expect(deps.mutateConversation).not.toHaveBeenCalled();
  });
});
