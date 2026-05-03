import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { HotkeyId } from "./hotkeys";

describe("HOTKEY_REGISTRY", () => {
  it("has an entry for every HotkeyId", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    const expectedIds: HotkeyId[] = [
      "helpModal",
      "voiceToggle",
      "voiceFireAndForget",
      "abortPrompt",
      "nextMessage",
      "prevMessage",
      "firstMessage",
      "lastMessage",
      "toggleSidebar",
      "nextFile",
      "prevFile",
      "nextChange",
      "prevChange",
    ];
    for (const id of expectedIds) {
      expect(HOTKEY_REGISTRY[id]).toBeDefined();
    }
  });

  it("has consistent id fields matching registry keys", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    for (const [key, def] of Object.entries(HOTKEY_REGISTRY)) {
      expect(def.id).toBe(key);
    }
  });

  it("all entries have required fields", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    for (const def of Object.values(HOTKEY_REGISTRY)) {
      expect(def.id).toBeTruthy();
      expect(def.keys).toBeTruthy();
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
      expect(["general", "navigation", "diff"]).toContain(def.category);
    }
  });

  it("voiceToggle has enableOnFormTags set", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    expect(HOTKEY_REGISTRY.voiceToggle.enableOnFormTags).toBe(true);
  });

  it("voiceFireAndForget has enableOnFormTags set", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    expect(HOTKEY_REGISTRY.voiceFireAndForget.enableOnFormTags).toBe(true);
  });

  it("abortPrompt has enableOnFormTags set", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    expect(HOTKEY_REGISTRY.abortPrompt.enableOnFormTags).toBe(true);
  });

  it("voiceToggle has enableOnContentEditable so it fires inside the Tiptap prompt editor", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    expect(HOTKEY_REGISTRY.voiceToggle.enableOnContentEditable).toBe(true);
  });

  it("voiceFireAndForget has enableOnContentEditable so it fires inside the Tiptap prompt editor", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    expect(HOTKEY_REGISTRY.voiceFireAndForget.enableOnContentEditable).toBe(
      true,
    );
  });

  it("abortPrompt has enableOnContentEditable so Escape clears the Tiptap prompt editor", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    expect(HOTKEY_REGISTRY.abortPrompt.enableOnContentEditable).toBe(true);
  });

  it("non-modifier hotkeys do not have enableOnFormTags", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    const nonModifierIds: HotkeyId[] = [
      "toggleSidebar",
      "nextMessage",
      "prevMessage",
      "firstMessage",
      "lastMessage",
      "nextFile",
      "prevFile",
      "nextChange",
      "prevChange",
    ];
    for (const id of nonModifierIds) {
      expect(HOTKEY_REGISTRY[id].enableOnFormTags).toBeFalsy();
    }
  });

  it("non-modifier hotkeys do not have enableOnContentEditable", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    const nonModifierIds: HotkeyId[] = [
      "toggleSidebar",
      "nextMessage",
      "prevMessage",
      "firstMessage",
      "lastMessage",
      "nextFile",
      "prevFile",
      "nextChange",
      "prevChange",
    ];
    for (const id of nonModifierIds) {
      expect(HOTKEY_REGISTRY[id].enableOnContentEditable).toBeFalsy();
    }
  });

  it("helpModal does not have enableOnFormTags so it cannot interfere with text input", async () => {
    const { HOTKEY_REGISTRY } = await import("./hotkeys");
    expect(HOTKEY_REGISTRY.helpModal.enableOnFormTags).toBeFalsy();
    expect(HOTKEY_REGISTRY.helpModal.useKey).toBe(true);
    expect(HOTKEY_REGISTRY.helpModal.keys).toBe("?");
  });
});

describe("isMacOS", () => {
  const origNavigator = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: origNavigator,
      writable: true,
      configurable: true,
    });
    vi.resetModules();
  });

  it("returns true on macOS platform", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "MacIntel" },
      writable: true,
      configurable: true,
    });
    const { isMacOS } = await import("./hotkeys");
    expect(isMacOS()).toBe(true);
  });

  it("returns false on Linux platform", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Linux x86_64" },
      writable: true,
      configurable: true,
    });
    const { isMacOS } = await import("./hotkeys");
    expect(isMacOS()).toBe(false);
  });

  it("returns false when navigator is undefined", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const { isMacOS } = await import("./hotkeys");
    expect(isMacOS()).toBe(false);
  });

  it("detects macOS via userAgentData", async () => {
    Object.defineProperty(globalThis, "navigator", {
      value: {
        platform: "Linux",
        userAgentData: { platform: "macOS" },
      },
      writable: true,
      configurable: true,
    });
    const { isMacOS } = await import("./hotkeys");
    expect(isMacOS()).toBe(true);
  });
});

describe("formatHotkeyDisplay", () => {
  const origNavigator = globalThis.navigator;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", {
      value: origNavigator,
      writable: true,
      configurable: true,
    });
    vi.resetModules();
  });

  describe("on Linux", () => {
    beforeEach(() => {
      Object.defineProperty(globalThis, "navigator", {
        value: { platform: "Linux x86_64" },
        writable: true,
        configurable: true,
      });
    });

    it("formats ? as ?", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("?")).toBe("?");
    });

    it("formats alt+v with Alt prefix", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("alt+v")).toBe("Alt V");
    });

    it("formats single key by capitalizing", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("j")).toBe("J");
    });

    it("formats shift+n with Shift prefix", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("shift+n")).toBe("Shift N");
    });

    it("preserves named keys like Home", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("Home")).toBe("Home");
    });

    it("formats mod+s as Ctrl S", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("mod+s")).toBe("Ctrl S");
    });

    it("formats mod+alt+v with Ctrl and Alt prefixes", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("mod+alt+v")).toBe("Ctrl Alt V");
    });
  });

  describe("on macOS", () => {
    beforeEach(() => {
      Object.defineProperty(globalThis, "navigator", {
        value: { platform: "MacIntel" },
        writable: true,
        configurable: true,
      });
    });

    it("formats ? as ?", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("?")).toBe("?");
    });

    it("formats alt+v with option symbol", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("alt+v")).toBe("\u2325 V");
    });

    it("formats mod+s with command symbol", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("mod+s")).toBe("\u2318 S");
    });

    it("formats shift+n with shift symbol", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("shift+n")).toBe("\u21E7 N");
    });

    it("formats single key by capitalizing", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("b")).toBe("B");
    });

    it("formats mod+alt+v with command and option symbols", async () => {
      const { formatHotkeyDisplay } = await import("./hotkeys");
      expect(formatHotkeyDisplay("mod+alt+v")).toBe("\u2318 \u2325 V");
    });
  });
});

describe("getCategoryLabel", () => {
  it("maps category to human-readable labels", async () => {
    const { getCategoryLabel } = await import("./hotkeys");
    expect(getCategoryLabel("general")).toBe("General");
    expect(getCategoryLabel("navigation")).toBe("Navigation");
    expect(getCategoryLabel("diff")).toBe("Diff Review");
  });
});
