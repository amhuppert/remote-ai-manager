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
      mode: "normal",
      initialPrompt: "do alpha",
    },
    {
      name: "beta",
      target: "main",
      agent: "codex",
      mode: "optimistic",
    },
  ],
};

function editable(overrides: Partial<EditableSession> = {}): EditableSession {
  return {
    name: "a",
    target: "main",
    agent: "claude",
    mode: "normal",
    initialPrompt: "",
    model: "opus",
    reasoningEffort: "high",
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

  it("defaults model + effort from each row's agent backend", () => {
    const rows = toEditableSessions(proposal);
    // claude → opus / high
    expect(rows[0]!.model).toBe("opus");
    expect(rows[0]!.reasoningEffort).toBe("high");
    // codex → gpt-5.4 / high
    expect(rows[1]!.model).toBe("gpt-5.4");
    expect(rows[1]!.reasoningEffort).toBe("high");
  });

  it("honors a model + effort already present on the proposal", () => {
    const rows = toEditableSessions({
      sessions: [
        {
          name: "a",
          target: "main",
          agent: "codex",
          mode: "normal",
          model: "gpt-5.4-mini",
          reasoningEffort: "low",
        },
      ],
    });
    expect(rows[0]!.model).toBe("gpt-5.4-mini");
    expect(rows[0]!.reasoningEffort).toBe("low");
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

  it("resets model + effort to the new backend's defaults on an agent change", () => {
    const rows = [editable({ agent: "claude", model: "opus" })];
    const next = updateEditableSession(rows, 0, "agent", "codex");
    expect(next[0]!.agent).toBe("codex");
    expect(next[0]!.model).toBe("gpt-5.4"); // codex default, not stale opus
    expect(next[0]!.reasoningEffort).toBe("high");
  });

  it("clamps the effort to the new model's supported levels on a model change", () => {
    // sonnet supports only [low, medium, high]; xhigh must clamp down to high.
    const rows = [
      editable({ agent: "claude", model: "opus", reasoningEffort: "xhigh" }),
    ];
    const next = updateEditableSession(rows, 0, "model", "sonnet");
    expect(next[0]!.model).toBe("sonnet");
    expect(next[0]!.reasoningEffort).toBe("high");
  });

  it("keeps a still-supported effort across a model change", () => {
    const rows = [
      editable({ agent: "claude", model: "opus", reasoningEffort: "medium" }),
    ];
    const next = updateEditableSession(rows, 0, "model", "sonnet");
    expect(next[0]!.reasoningEffort).toBe("medium");
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

  it("emits model + reasoningEffort for a single-backend agent", () => {
    const rows = [
      editable({ agent: "codex", model: "gpt-5.4", reasoningEffort: "medium" }),
    ];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.model).toBe("gpt-5.4");
    expect(result.sessions[0]!.reasoningEffort).toBe("medium");
  });

  it("omits model + reasoningEffort for a dual agent (both run defaults)", () => {
    const rows = [editable({ agent: "dual" })];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.model).toBeUndefined();
    expect(result.sessions[0]!.reasoningEffort).toBeUndefined();
  });

  it("emits model but omits reasoningEffort when the model supports no effort levels", () => {
    // haiku supports no reasoning levels — the model still ships, the effort does not.
    const rows = [
      editable({ agent: "claude", model: "haiku", reasoningEffort: "high" }),
    ];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.model).toBe("haiku");
    expect(result.sessions[0]!.reasoningEffort).toBeUndefined();
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
