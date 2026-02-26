export type HotkeyCategory = "general" | "navigation" | "diff";

export interface HotkeyDefinition {
  readonly id: string;
  readonly keys: string;
  readonly label: string;
  readonly description: string;
  readonly category: HotkeyCategory;
  readonly enableOnFormTags?: boolean;
  readonly useKey?: boolean;
}

export type HotkeyId =
  | "helpModal"
  | "voiceToggle"
  | "voiceFireAndForget"
  | "abortPrompt"
  | "nextMessage"
  | "prevMessage"
  | "firstMessage"
  | "lastMessage"
  | "toggleSidebar"
  | "toggleActivePanel"
  | "nextFile"
  | "prevFile"
  | "nextChange"
  | "prevChange";

export type HotkeyRegistry = Record<HotkeyId, HotkeyDefinition>;

export const HOTKEY_REGISTRY: HotkeyRegistry = {
  helpModal: {
    id: "helpModal",
    keys: "?",
    label: "Show keyboard shortcuts",
    description: "Open the keyboard shortcuts help modal",
    category: "general",
    useKey: true,
  },
  voiceToggle: {
    id: "voiceToggle",
    keys: "alt+v",
    label: "Toggle voice recording",
    description: "Start or stop voice recording for prompt input",
    category: "general",
    enableOnFormTags: true,
  },
  voiceFireAndForget: {
    id: "voiceFireAndForget",
    keys: "mod+alt+v",
    label: "Voice fire-and-forget",
    description: "Record voice and auto-submit when transcription completes",
    category: "general",
    enableOnFormTags: true,
  },
  abortPrompt: {
    id: "abortPrompt",
    keys: "Escape",
    label: "Abort prompt / clear input",
    description: "Cancel a running prompt, or clear the input field when idle",
    category: "general",
    enableOnFormTags: true,
  },
  toggleSidebar: {
    id: "toggleSidebar",
    keys: "b",
    label: "Toggle sidebar",
    description: "Expand or collapse the conversations sidebar",
    category: "general",
  },
  toggleActivePanel: {
    id: "toggleActivePanel",
    keys: "shift+b",
    label: "Toggle active conversations",
    description: "Open or close the active conversations panel",
    category: "general",
  },
  nextMessage: {
    id: "nextMessage",
    keys: "j",
    label: "Next message",
    description: "Scroll to the next message in the conversation",
    category: "navigation",
  },
  prevMessage: {
    id: "prevMessage",
    keys: "k",
    label: "Previous message",
    description: "Scroll to the previous message in the conversation",
    category: "navigation",
  },
  firstMessage: {
    id: "firstMessage",
    keys: "Home",
    label: "First message",
    description: "Scroll to the first message in the conversation",
    category: "navigation",
  },
  lastMessage: {
    id: "lastMessage",
    keys: "End",
    label: "Last message",
    description: "Scroll to the last message in the conversation",
    category: "navigation",
  },
  nextFile: {
    id: "nextFile",
    keys: "]",
    label: "Next file",
    description: "Jump to the next file in the diff panel",
    category: "diff",
  },
  prevFile: {
    id: "prevFile",
    keys: "[",
    label: "Previous file",
    description: "Jump to the previous file in the diff panel",
    category: "diff",
  },
  nextChange: {
    id: "nextChange",
    keys: "n",
    label: "Next change",
    description: "Jump to the next diff hunk",
    category: "diff",
  },
  prevChange: {
    id: "prevChange",
    keys: "shift+n",
    label: "Previous change",
    description: "Jump to the previous diff hunk",
    category: "diff",
  },
};

/**
 * Detect if the current platform is macOS.
 */
export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  // Modern API
  if ("userAgentData" in navigator) {
    const uad = navigator as Navigator & {
      userAgentData?: { platform: string };
    };
    if (uad.userAgentData?.platform) {
      return uad.userAgentData.platform === "macOS";
    }
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

const CATEGORY_LABELS: Record<HotkeyCategory, string> = {
  general: "General",
  navigation: "Navigation",
  diff: "Diff Review",
};

export function getCategoryLabel(category: HotkeyCategory): string {
  return CATEGORY_LABELS[category];
}

/**
 * Format a hotkey key string for display with platform-correct modifier symbols.
 */
export function formatHotkeyDisplay(keys: string): string {
  // Single-character keys like "?" display as-is
  if (keys === "?") return "?";

  const mac = isMacOS();
  const parts = keys.split("+");
  const mapped = parts.map((part) => {
    const lower = part.toLowerCase();
    if (lower === "mod") return mac ? "\u2318" : "Ctrl";
    if (lower === "alt") return mac ? "\u2325" : "Alt";
    if (lower === "shift") return mac ? "\u21E7" : "Shift";
    // Capitalize single-character keys
    if (part.length === 1) return part.toUpperCase();
    // Named keys: preserve casing (Home, End, etc.)
    return part;
  });
  return mapped.join(" ");
}
