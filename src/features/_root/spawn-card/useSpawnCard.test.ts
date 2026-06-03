import { describe, it, expect } from "vitest";
import {
  toEditableSessions,
  updateEditableSession,
  toSpawnProposal,
  type EditableSession,
} from "./useSpawnCard";
import type { SpawnProposal } from "@/lib/chat-spawning/schemas";

const proposal: SpawnProposal = {
  sessions: [
    {
      name: "alpha",
      branch: "feat/alpha",
      target: "main",
      agent: "claude",
      mode: "fast",
      initialPrompt: "do alpha",
    },
    {
      name: "beta",
      branch: "feat/beta",
      target: "main",
      agent: "codex",
      mode: "focus",
    },
  ],
};

describe("toEditableSessions", () => {
  it("projects a proposal into editable rows with initialPrompt as a string", () => {
    const rows = toEditableSessions(proposal);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.initialPrompt).toBe("do alpha");
    expect(rows[1]!.initialPrompt).toBe("");
  });
});

describe("updateEditableSession", () => {
  it("updates one field at one index without mutating the input", () => {
    const rows = toEditableSessions(proposal);
    const next = updateEditableSession(rows, 0, "name", "renamed");
    expect(next[0]!.name).toBe("renamed");
    expect(rows[0]!.name).toBe("alpha"); // original untouched
    expect(next[1]).toEqual(rows[1]); // other rows unchanged
  });
});

describe("toSpawnProposal", () => {
  it("maps edited rows back, reflecting the edits in the submitted payload", () => {
    let rows = toEditableSessions(proposal);
    rows = updateEditableSession(rows, 0, "name", "renamed-alpha");
    rows = updateEditableSession(rows, 0, "initialPrompt", "edited prompt");
    rows = updateEditableSession(rows, 1, "agent", "dual");

    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.name).toBe("renamed-alpha");
    expect(result.sessions[0]!.initialPrompt).toBe("edited prompt");
    expect(result.sessions[1]!.agent).toBe("dual");
  });

  it("omits an empty initialPrompt and defaults an empty target to main", () => {
    const rows: EditableSession[] = [
      {
        name: "a",
        branch: "feat/a",
        target: "",
        agent: "claude",
        mode: "fast",
        initialPrompt: "   ",
      },
    ];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.initialPrompt).toBeUndefined();
    expect(result.sessions[0]!.target).toBe("main");
  });

  it("trims text fields", () => {
    const rows: EditableSession[] = [
      {
        name: "  spaced  ",
        branch: "  feat/x  ",
        target: "main",
        agent: "claude",
        mode: "fast",
        initialPrompt: "  go  ",
      },
    ];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.name).toBe("spaced");
    expect(result.sessions[0]!.branch).toBe("feat/x");
    expect(result.sessions[0]!.initialPrompt).toBe("go");
  });
});
