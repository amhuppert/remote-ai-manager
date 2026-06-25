import { describe, it, expect } from "vitest";
import {
  toEditableSessions,
  updateEditableSession,
  setSessionIncluded,
  toSpawnProposal,
  summarizePrompt,
  type EditableSession,
} from "./useSpawnCard";
import type { SpawnProposal } from "@/lib/chat-spawning/schemas";

const proposal: SpawnProposal = {
  sessions: [
    {
      name: "alpha",
      target: "main",
      agent: "claude",
      mode: "fast",
      initialPrompt: "do alpha",
    },
    {
      name: "beta",
      target: "main",
      agent: "codex",
      mode: "focus",
    },
  ],
};

function editable(overrides: Partial<EditableSession> = {}): EditableSession {
  return {
    name: "a",
    target: "main",
    agent: "claude",
    mode: "fast",
    initialPrompt: "",
    included: true,
    ...overrides,
  };
}

describe("toEditableSessions", () => {
  it("projects a proposal into editable rows with initialPrompt as a string", () => {
    const rows = toEditableSessions(proposal);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.initialPrompt).toBe("do alpha");
    expect(rows[1]!.initialPrompt).toBe("");
  });

  it("marks every projected row as included by default", () => {
    const rows = toEditableSessions(proposal);
    expect(rows.every((r) => r.included)).toBe(true);
  });

  it("does not carry a branch — the server derives it from the name", () => {
    const rows = toEditableSessions(proposal);
    expect("branch" in rows[0]!).toBe(false);
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

describe("setSessionIncluded", () => {
  it("toggles include at one index without mutating the input", () => {
    const rows = toEditableSessions(proposal);
    const next = setSessionIncluded(rows, 1, false);
    expect(next[1]!.included).toBe(false);
    expect(rows[1]!.included).toBe(true); // original untouched
    expect(next[0]).toEqual(rows[0]); // other rows unchanged
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

  it("omits excluded sessions from the submitted payload", () => {
    const rows = setSessionIncluded(toEditableSessions(proposal), 0, false);
    const result = toSpawnProposal(rows);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]!.name).toBe("beta");
  });

  it("never emits a branch field", () => {
    const result = toSpawnProposal(toEditableSessions(proposal));
    expect("branch" in result.sessions[0]!).toBe(false);
  });

  it("omits an empty initialPrompt and defaults an empty target to main", () => {
    const rows = [editable({ target: "", initialPrompt: "   " })];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.initialPrompt).toBeUndefined();
    expect(result.sessions[0]!.target).toBe("main");
  });

  it("trims text fields", () => {
    const rows = [editable({ name: "  spaced  ", initialPrompt: "  go  " })];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.name).toBe("spaced");
    expect(result.sessions[0]!.initialPrompt).toBe("go");
  });
});

describe("summarizePrompt", () => {
  it("returns the full text and long=false for a short prompt", () => {
    const { display, long } = summarizePrompt("short prompt", false, 92);
    expect(long).toBe(false);
    expect(display).toBe("short prompt");
  });

  it("truncates a long prompt at a word boundary with an ellipsis", () => {
    const text =
      "Audit dependencies for known vulnerabilities and suggest a safe upgrade path for each one.";
    const { display, long } = summarizePrompt(text, false, 40);
    expect(long).toBe(true);
    expect(display.endsWith("…")).toBe(true);
    expect(display.length).toBeLessThan(text.length);
    // The kept text is a whole-word prefix of the source: it is a prefix, and
    // the next source character is whitespace (so no word was cut in half).
    const kept = display.slice(0, -1);
    expect(text.startsWith(kept)).toBe(true);
    expect(/\s/.test(text.charAt(kept.length))).toBe(true);
  });

  it("returns the full text when expanded, even if long", () => {
    const text = "x".repeat(120);
    const { display, long } = summarizePrompt(text, true, 92);
    expect(long).toBe(true);
    expect(display).toBe(text);
  });
});
