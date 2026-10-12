import { describe, expect, it } from "vitest";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { custodyFence } from "./custody-fence";

describe("whether custody may open for a conversation (design C5b §5)", () => {
  const place = {
    conversationId: "conv-1",
    projectPath: "/repo",
    sessionName: "feature",
  };
  const open = {
    session: () => ({ finished: false, archived: false }),
    finalizingMerge: () => null,
    conversationArchived: () => false,
    projectArchived: () => false,
  };

  it("closes the session while a merge delivers it", () => {
    expect(
      custodyFence(place, {
        ...open,
        finalizingMerge: (projectPath, sessionName) =>
          projectPath === "/repo" && sessionName === "feature"
            ? { jobId: "job-1" }
            : null,
      }),
    ).toBe("merging");
  });

  it("closes a finished (merged) or deleted session, and leaves an open one open", () => {
    expect(
      custodyFence(place, {
        ...open,
        session: () => ({ finished: true, archived: true }),
      }),
    ).toBe("merged");
    expect(custodyFence(place, { ...open, session: () => null })).toBe(
      "deleted",
    );
    expect(custodyFence(place, open)).toBeNull();
  });

  it("closes an archived conversation, session or project, whose background work nothing would show", () => {
    expect(
      custodyFence(place, {
        ...open,
        session: () => ({ finished: false, archived: true }),
      }),
    ).toBe("archived");
    expect(
      custodyFence(place, {
        ...open,
        conversationArchived: (archived) =>
          archived.conversationId === "conv-1",
      }),
    ).toBe("archived");
    expect(
      custodyFence(place, {
        ...open,
        projectArchived: (projectPath) => projectPath === "/repo",
      }),
    ).toBe("archived");
  });

  it("closes a project conversation only by its own or its project's archive: it has no session to merge", () => {
    const projectPlace = {
      ...place,
      sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
    };
    const read: string[] = [];
    const reads = {
      ...open,
      session: () => {
        read.push("session");
        return null;
      },
      finalizingMerge: () => {
        read.push("merge");
        return null;
      },
    };
    expect(custodyFence(projectPlace, reads)).toBeNull();
    expect(read).toEqual([]);
    expect(
      custodyFence(projectPlace, {
        ...reads,
        conversationArchived: () => true,
      }),
    ).toBe("archived");
  });
});
