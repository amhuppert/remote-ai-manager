export type HotkeyCategory = "general" | "navigation" | "diff";

export interface HotkeyDefinition {
  readonly id: string;
  readonly keys: string;
  readonly label: string;
  readonly description: string;
  readonly category: HotkeyCategory;
  readonly enableOnFormTags?: boolean;
  readonly enableOnContentEditable?: boolean;
  readonly useKey?: boolean;
}

export type HotkeyId =
  | "helpModal"
  | "voiceToggle"
  | "clearInput"
  | "nextMessage"
  | "prevMessage"
  | "firstMessage"
  | "lastMessage"
  | "toggleSidebar"
  | "toggleDevTools"
  | "focusSidebarSearch"
  | "nextFile"
  | "prevFile"
  | "nextChange"
  | "prevChange"
  | "newSession"
  | "focusCommandConsole"
  | "activateOpenTab"
  | "exitPanes"
  | "expandThinkingBlocks"
  | "collapseThinkingBlocks"
  | "switchProject"
  | "switchSession"
  | "quickTicket";

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
    enableOnContentEditable: true,
  },
  clearInput: {
    id: "clearInput",
    keys: "Escape",
    label: "Clear prompt input",
    description: "Clear the prompt input field when it has focus",
    category: "general",
    enableOnFormTags: true,
    enableOnContentEditable: true,
  },
  toggleSidebar: {
    id: "toggleSidebar",
    keys: "b",
    label: "Toggle sidebar",
    description: "Expand or collapse the conversations sidebar",
    category: "general",
  },
  toggleDevTools: {
    id: "toggleDevTools",
    keys: "shift+d",
    label: "Toggle dev tools",
    description:
      "Show or hide dev tool buttons (Next.js panel, TanStack Query)",
    category: "general",
  },
  // focusSidebarSearch and focusCommandConsole intentionally share mod+k: they
  // are route-exclusive (sidebar search lives on the session page via
  // ConversationSidebar; the command console lives on the project page via
  // ProjectDetailView) and never mount together, so the binding never collides.
  focusSidebarSearch: {
    id: "focusSidebarSearch",
    keys: "mod+k",
    label: "Focus sidebar search",
    description: "Focus the search input in the conversations sidebar",
    category: "general",
    enableOnFormTags: true,
    enableOnContentEditable: true,
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
  newSession: {
    id: "newSession",
    keys: "mod+n",
    label: "New session",
    description: "Open the New Session modal on the project page",
    category: "general",
    enableOnFormTags: true,
    enableOnContentEditable: true,
  },
  focusCommandConsole: {
    id: "focusCommandConsole",
    keys: "mod+k",
    label: "Focus command console",
    description: "Focus the project page command console",
    category: "general",
    enableOnFormTags: true,
    enableOnContentEditable: true,
  },
  activateOpenTab: {
    id: "activateOpenTab",
    keys: "mod+1,mod+2,mod+3,mod+4,mod+5,mod+6,mod+7,mod+8,mod+9", // comma-list: react-hotkeys-hook binds each; the hook reads event.key for the index
    label: "Activate open conversation",
    description:
      "Switch to the Nth open conversation (1-9) in the tab/panes working set",
    category: "navigation",
  },
  // exitPanes shares the Escape key with clearInput: clearInput is
  // enableOnFormTags (fires while the composer has focus) whereas exitPanes is
  // not and is gated to panes mode by its hook, so they never collide. Mirrors
  // the focusSidebarSearch/focusCommandConsole mod+k co-existence above.
  exitPanes: {
    id: "exitPanes",
    keys: "Escape",
    label: "Exit panes layout",
    description: "Leave the panes (split-screen) layout",
    category: "navigation",
  },
  expandThinkingBlocks: {
    id: "expandThinkingBlocks",
    keys: "shift+e",
    label: "Expand thinking blocks",
    description: "Expand all thinking blocks in the active conversation",
    category: "navigation",
  },
  collapseThinkingBlocks: {
    id: "collapseThinkingBlocks",
    keys: "shift+c",
    label: "Collapse thinking blocks",
    description: "Collapse all thinking blocks in the active conversation",
    category: "navigation",
  },
  // mod+k (the design's first choice for the session switcher) is owned by
  // focusSidebarSearch/focusCommandConsole, so the switchers use the free
  // mod+p / mod+j chords instead.
  switchProject: {
    id: "switchProject",
    keys: "mod+p",
    label: "Switch project",
    description: "Open the project switcher in the top bar",
    category: "navigation",
    enableOnFormTags: true,
    enableOnContentEditable: true,
  },
  switchSession: {
    id: "switchSession",
    keys: "mod+j",
    label: "Switch session",
    description: "Open the session switcher in the top bar",
    category: "navigation",
    enableOnFormTags: true,
    enableOnContentEditable: true,
  },
  quickTicket: {
    id: "quickTicket",
    keys: "mod+shift+k",
    label: "Quick ticket",
    description: "Open the quick-ticket dialog",
    category: "general",
    enableOnFormTags: true,
    enableOnContentEditable: true,
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
