import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HotkeyId } from "./hotkeys";

describe("HOTKEY_REGISTRY", () => {
  it("contains the complete command vocabulary", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    const expectedIds: HotkeyId[] = [
      "helpModal",
      "commandLauncher",
      "voiceToggle",
      "stopTurn",
      "clearInput",
      "toggleSidebar",
      "toggleDevTools",
      "focusContextSearch",
      "focusComposer",
      "nextMessage",
      "prevMessage",
      "firstMessage",
      "lastMessage",
      "nextFile",
      "prevFile",
      "nextChange",
      "prevChange",
      "newSession",
      "newConversation",
      "newWorkflow",
      "activateOpenTab",
      "closeConversationTab",
      "exitPanes",
      "expandThinkingBlocks",
      "collapseThinkingBlocks",
      "goProjects",
      "switchProject",
      "switchSession",
      "goConversations",
      "goTickets",
      "goSpecs",
      "openNeedsYou",
      "nextConversation",
      "prevConversation",
      "quickTicket",
      "viewPrevious",
      "viewConversation",
      "viewDiff",
      "viewDocuments",
      "viewAlignment",
      "viewSpecs",
      "viewArtifact",
      "viewPanes",
      "viewSessions",
      "viewBoard",
      "viewList",
    ];

    expect(Object.keys(HOTKEY_REGISTRY).sort()).toEqual(expectedIds.sort());
  });

  it("uses the approved conflict-resistant bindings", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");

    expect(HOTKEY_REGISTRY.helpModal.keys).toBe("shift+/");
    expect(HOTKEY_REGISTRY.commandLauncher.keys).toBe(".");
    expect(HOTKEY_REGISTRY.switchProject.keys).toBe("g>p");
    expect(HOTKEY_REGISTRY.switchSession.keys).toBe("g>s");
    expect(HOTKEY_REGISTRY.newSession.keys).toBe("c>s");
    expect(HOTKEY_REGISTRY.quickTicket.keys).toBe("c>t");
    expect(HOTKEY_REGISTRY.activateOpenTab.keys).toBe(
      "g>1,g>2,g>3,g>4,g>5,g>6,g>7,g>8,g>9",
    );
    expect(HOTKEY_REGISTRY.closeConversationTab.keys).toBe("x");
    expect(HOTKEY_REGISTRY.firstMessage.keys).toBe("g>g");
    expect(HOTKEY_REGISTRY.lastMessage.keys).toBe("shift+g");
    expect(HOTKEY_REGISTRY.voiceToggle.keys).toBe("ctrl+shift+.");
    expect(HOTKEY_REGISTRY.stopTurn.keys).toBe("ctrl+.");
  });

  it("keeps the exact thinking expansion bindings", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");

    expect(HOTKEY_REGISTRY.expandThinkingBlocks.keys).toBe("shift+e");
    expect(HOTKEY_REGISTRY.collapseThinkingBlocks.keys).toBe("shift+c");
  });

  it("keeps infrequent and destructive prompt actions launcher-only", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");

    expect(HOTKEY_REGISTRY.clearInput.keys).toBeNull();
    expect(HOTKEY_REGISTRY.toggleDevTools.keys).toBeNull();
  });

  it("marks only literal prompt chords as directly available in editors", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    const directPromptIds = Object.values(HOTKEY_REGISTRY)
      .filter((definition) => definition.allowInEditable)
      .map((definition) => definition.id)
      .sort();

    expect(directPromptIds).toEqual(["stopTurn", "voiceToggle"]);
  });

  it("does not assign direct Alt/Option shortcuts", async () => {
    const { HOTKEY_REGISTRY, getHotkeySequences } = await import("./hotkeys");

    for (const definition of Object.values(HOTKEY_REGISTRY)) {
      for (const sequence of getHotkeySequences(definition.keys)) {
        expect(sequence.some((stroke) => stroke.includes("alt+"))).toBe(false);
      }
    }
  });

  it("documents the preserved readline-style prompt bindings separately", async () => {
    const { PROMPT_EDITING_SHORTCUTS } = await import("./hotkeys");

    expect(
      PROMPT_EDITING_SHORTCUTS.map(({ keys, label }) => [keys, label]),
    ).toEqual([
      ["ctrl+;", "Activate one app shortcut"],
      ["mod+enter", "Submit prompt"],
      ["ctrl+a", "Move to line start"],
      ["ctrl+e", "Move to line end"],
      ["ctrl+u", "Delete to line start"],
      ["ctrl+k", "Delete to line end"],
      ["ctrl+w", "Delete previous word"],
      ["alt+b", "Move one word backward"],
      ["alt+f", "Move one word forward"],
      ["alt+d", "Delete next word"],
    ]);
  });

  it("has consistent ids and complete user-facing metadata", async () => {
    const { HOTKEY_REGISTRY, getCategoryLabel } = await import("./hotkeys");

    for (const [id, definition] of Object.entries(HOTKEY_REGISTRY)) {
      expect(definition.id).toBe(id);
      expect(definition.label).toBeTruthy();
      expect(definition.description).toBeTruthy();
      expect(getCategoryLabel(definition.category)).toBeTruthy();
    }
  });
});

describe("getHotkeySequences", () => {
  it("parses alternatives and multi-stroke sequences", async () => {
    const { getHotkeySequences } = await import("./hotkeys");

    expect(getHotkeySequences("g>1,g>2,g>3")).toEqual([
      ["g", "1"],
      ["g", "2"],
      ["g", "3"],
    ]);
    expect(getHotkeySequences(null)).toEqual([]);
  });
});

describe("isMacOS", () => {
  const originalNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    vi.resetModules();
  });

  it("detects macOS from platform and userAgentData", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Linux", userAgentData: { platform: "macOS" } },
      writable: true,
      configurable: true,
    });
    const { isMacOS } = await import("./hotkeys");

    expect(isMacOS()).toBe(true);
  });

  it("returns false without a navigator", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const { isMacOS } = await import("./hotkeys");

    expect(isMacOS()).toBe(false);
  });
});

describe("formatHotkeyDisplay", () => {
  const originalNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: originalNavigator,
      writable: true,
      configurable: true,
    });
    vi.resetModules();
  });

  it("formats a sequence as distinct strokes on Linux", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Linux x86_64" },
      writable: true,
      configurable: true,
    });
    const { formatHotkeyDisplay } = await import("./hotkeys");

    expect(formatHotkeyDisplay("g>p")).toBe("G then P");
    expect(formatHotkeyDisplay("ctrl+shift+.")).toBe("Ctrl Shift .");
  });

  it("uses platform-correct symbols on macOS", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      writable: true,
      configurable: true,
    });
    const { formatHotkeyDisplay } = await import("./hotkeys");

    expect(formatHotkeyDisplay("mod+shift+p")).toBe("⌘ ⇧ P");
    expect(formatHotkeyDisplay("ctrl+;")).toBe("⌃ ;");
  });

  it("formats alternatives without flattening their sequence boundaries", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Linux x86_64" },
      writable: true,
      configurable: true,
    });
    const { formatHotkeyDisplay } = await import("./hotkeys");

    expect(formatHotkeyDisplay("g>1,g>2")).toBe("G then 1 / G then 2");
  });
});

describe("getCategoryLabel", () => {
  it("maps every category to a user-facing heading", async () => {
    const { getCategoryLabel } = await import("./hotkeys");

    expect(getCategoryLabel("general")).toBe("General");
    expect(getCategoryLabel("navigation")).toBe("Navigation");
    expect(getCategoryLabel("creation")).toBe("Create");
    expect(getCategoryLabel("conversation")).toBe("Conversation");
    expect(getCategoryLabel("review")).toBe("Review");
    expect(getCategoryLabel("diff")).toBe("Diff Review");
    expect(getCategoryLabel("views")).toBe("Views");
    expect(getCategoryLabel("development")).toBe("Development");
  });
});
