import { describe, it, expect } from "vitest";
import {
  applyPromptDocument,
  setSessionImages,
  setSessionModelSelection,
  toEditableSessions,
  updateEditableSession,
  setSessionIncluded,
  toSpawnProposal,
  summarizePrompt,
  type EditableSession,
} from "./useSpawnCard";
import type { SpawnProposal } from "@/lib/chat-spawning/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

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
    modelSelection: {
      modelId: "opus",
      parameters: { effort: "high" },
    },
    included: true,
    ...overrides,
  };
}

describe("toEditableSessions", () => {
  it("defaults each row from the configured profile for its backend", () => {
    const rows = toEditableSessions(proposal, BACKEND_DEFAULTS);
    expect(rows[0]!.modelSelection).toEqual(BACKEND_DEFAULTS.claude);
    expect(rows[1]!.modelSelection).toEqual(BACKEND_DEFAULTS.codex);
  });

  it("preserves a custom Codex profile model through the submitted proposal", () => {
    const rows = toEditableSessions(proposal, {
      claude: { modelId: "sonnet", parameters: { effort: "medium" } },
      codex: {
        modelId: "custom-codex-model",
        parameters: { reasoning: "ultra", fast: "false" },
      },
      cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
    });

    expect(rows[1]!.modelSelection).toEqual({
      modelId: "custom-codex-model",
      parameters: { reasoning: "ultra", fast: "false" },
    });
    expect(toSpawnProposal(rows).sessions[1]!.modelSelection).toEqual({
      modelId: "custom-codex-model",
      parameters: { reasoning: "ultra", fast: "false" },
    });
  });

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

  it("defaults a complete model variant from each row's agent backend", () => {
    const rows = toEditableSessions(proposal);
    expect(rows[0]!.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
    expect(rows[1]!.modelSelection).toEqual({
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "false" },
    });
  });

  it("honors a complete selection already present on the proposal", () => {
    const rows = toEditableSessions({
      sessions: [
        {
          name: "a",
          target: "main",
          agent: "codex",
          mode: "normal",
          modelSelection: {
            modelId: "gpt-5.4-mini",
            parameters: { reasoning: "low", fast: "false" },
          },
        },
      ],
    });
    expect(rows[0]!.modelSelection).toEqual({
      modelId: "gpt-5.4-mini",
      parameters: { reasoning: "low", fast: "false" },
    });
  });
});

describe("updateEditableSession", () => {
  it("resets the whole selection to the configured profile on agent change", () => {
    const rows = [editable({ agent: "claude" })];
    const next = updateEditableSession(
      rows,
      0,
      "agent",
      "codex",
      BACKEND_DEFAULTS,
    );
    expect(next[0]!.agent).toBe("codex");
    expect(next[0]!.modelSelection).toEqual(BACKEND_DEFAULTS.codex);
  });

  it("updates one field at one index without mutating the input", () => {
    const rows = toEditableSessions(proposal);
    const next = updateEditableSession(rows, 0, "name", "renamed");
    expect(next[0]!.name).toBe("renamed");
    expect(rows[0]!.name).toBe("alpha"); // original untouched
    expect(next[1]).toEqual(rows[1]); // other rows unchanged
  });

  it("resets the complete selection to the new backend's catalog default", () => {
    const rows = [editable({ agent: "claude" })];
    const next = updateEditableSession(rows, 0, "agent", "codex");
    expect(next[0]!.agent).toBe("codex");
    expect(next[0]!.modelSelection).toEqual({
      modelId: "gpt-5.4",
      parameters: { reasoning: "high", fast: "false" },
    });
  });

  it("replaces a selection atomically without retaining old parameters", () => {
    const rows = [editable()];
    const selection = {
      modelId: "sonnet",
      parameters: { effort: "low" },
    };
    const next = setSessionModelSelection(rows, 0, selection);
    expect(next[0]!.modelSelection).toEqual(selection);
    expect(next[0]!.modelSelection).not.toBe(selection);
    expect(rows[0]!.modelSelection).toEqual({
      modelId: "opus",
      parameters: { effort: "high" },
    });
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

describe("applyPromptDocument", () => {
  it("uses the submitted rich prompt document instead of waiting for image state effects", () => {
    const rows = toEditableSessions(proposal);
    const next = applyPromptDocument(rows, 0, {
      prompt: "Compare [Image #1] and [Image #2]",
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "first-data",
        },
        {
          attachmentId: "second",
          mediaType: "image/jpeg",
          base64Data: "second-data",
        },
      ],
    });

    expect(next[0]).toMatchObject({
      initialPrompt: "Compare [Image #1] and [Image #2]",
      images: [{ attachmentId: "first" }, { attachmentId: "second" }],
    });
    expect(rows[0]!.images).toEqual([]);
  });
});

describe("setSessionImages", () => {
  it("preserves state identity when the serialized image payload is unchanged", () => {
    const images = [
      {
        attachmentId: "image-1",
        mediaType: "image/png" as const,
        base64Data: "aW1hZ2U=",
      },
    ];
    const rows = [editable({ images })];

    expect(setSessionImages(rows, 0, [...images])).toBe(rows);
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

  it("emits one whole model selection for a single-backend agent", () => {
    const rows = [
      editable({
        agent: "codex",
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { reasoning: "medium", fast: "false" },
        },
      }),
    ];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.modelSelection).toEqual({
      modelId: "gpt-5.4",
      parameters: { reasoning: "medium", fast: "false" },
    });
    expect("model" in result.sessions[0]!).toBe(false);
    expect("reasoningEffort" in result.sessions[0]!).toBe(false);
  });

  it("omits modelSelection for a dual agent (both run defaults)", () => {
    const rows = [editable({ agent: "dual", modelSelection: null })];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.modelSelection).toBeUndefined();
  });

  it("preserves the empty parameter set for a model with no controls", () => {
    const rows = [
      editable({
        agent: "claude",
        modelSelection: { modelId: "haiku", parameters: {} },
      }),
    ];
    const result = toSpawnProposal(rows);
    expect(result.sessions[0]!.modelSelection).toEqual({
      modelId: "haiku",
      parameters: {},
    });
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
