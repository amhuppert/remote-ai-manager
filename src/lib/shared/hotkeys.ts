export type HotkeyCategory =
  | "general"
  | "navigation"
  | "creation"
  | "conversation"
  | "review"
  | "diff"
  | "views"
  | "development";

export interface HotkeyDefinition {
  readonly id: HotkeyId;
  readonly keys: string | null;
  readonly label: string;
  readonly description: string;
  readonly category: HotkeyCategory;
  readonly allowInEditable?: boolean;
}

export interface PromptEditingShortcutDefinition {
  readonly keys: string;
  readonly label: string;
  readonly description: string;
}

export type HotkeyId =
  | "helpModal"
  | "commandLauncher"
  | "voiceToggle"
  | "voiceQuickCapture"
  | "stopTurn"
  | "clearInput"
  | "toggleSidebar"
  | "toggleDevTools"
  | "focusContextSearch"
  | "focusComposer"
  | "nextMessage"
  | "prevMessage"
  | "firstMessage"
  | "lastMessage"
  | "nextFile"
  | "prevFile"
  | "nextChange"
  | "prevChange"
  | "newSession"
  | "newConversation"
  | "newWorkflow"
  | "activateOpenTab"
  | "closeConversationTab"
  | "exitPanes"
  | "expandThinkingBlocks"
  | "collapseThinkingBlocks"
  | "goProjects"
  | "switchProject"
  | "switchSession"
  | "goConversations"
  | "goTickets"
  | "goSpecs"
  | "openNeedsYou"
  | "nextConversation"
  | "prevConversation"
  | "quickTicket"
  | "viewPrevious"
  | "viewConversation"
  | "viewDiff"
  | "viewDocuments"
  | "viewAlignment"
  | "viewSpecs"
  | "viewArtifact"
  | "viewSplit"
  | "viewPanes"
  | "viewSessions"
  | "viewBoard"
  | "viewList";

export type HotkeyRegistry = Record<HotkeyId, HotkeyDefinition>;

export const HOTKEY_REGISTRY: HotkeyRegistry = {
  helpModal: {
    id: "helpModal",
    keys: "shift+/",
    label: "Keyboard shortcuts",
    description: "Open the complete keyboard shortcut reference",
    category: "general",
  },
  commandLauncher: {
    id: "commandLauncher",
    keys: ".",
    label: "Command launcher",
    description: "Search and run commands available in the current context",
    category: "general",
  },
  voiceToggle: {
    id: "voiceToggle",
    keys: "ctrl+shift+.",
    label: "Toggle voice recording",
    description: "Start or stop voice recording for the focused editor",
    category: "general",
    allowInEditable: true,
  },
  voiceQuickCapture: {
    id: "voiceQuickCapture",
    keys: "ctrl+shift+,",
    label: "Voice quick capture",
    description: "Record a voice note into a notepad from anywhere",
    category: "creation",
    // A thought worth capturing usually arrives mid-sentence, so this fires
    // while a prompt or editor holds focus — voiceToggle's precedent.
    allowInEditable: true,
  },
  stopTurn: {
    id: "stopTurn",
    keys: "ctrl+.",
    label: "Stop active turn",
    description: "Stop the active conversation turn",
    category: "conversation",
    allowInEditable: true,
  },
  clearInput: {
    id: "clearInput",
    keys: null,
    label: "Clear prompt",
    description: "Clear the prompt text and attachments",
    category: "general",
  },
  toggleSidebar: {
    id: "toggleSidebar",
    keys: "b",
    label: "Toggle sidebar",
    description: "Expand or collapse the conversation sidebar",
    category: "general",
  },
  toggleDevTools: {
    id: "toggleDevTools",
    keys: null,
    label: "Toggle developer tools",
    description: "Show or hide the development tool controls",
    category: "development",
  },
  focusContextSearch: {
    id: "focusContextSearch",
    keys: "/",
    label: "Search here",
    description: "Focus the search or filter for the current view",
    category: "general",
  },
  focusComposer: {
    id: "focusComposer",
    keys: "i",
    label: "Focus prompt",
    description: "Move focus to the active conversation prompt",
    category: "conversation",
  },
  nextMessage: {
    id: "nextMessage",
    keys: "j",
    label: "Next message",
    description: "Move to the next message in the active conversation",
    category: "conversation",
  },
  prevMessage: {
    id: "prevMessage",
    keys: "k",
    label: "Previous message",
    description: "Move to the previous message in the active conversation",
    category: "conversation",
  },
  firstMessage: {
    id: "firstMessage",
    keys: "g>g",
    label: "First message",
    description: "Move to the first message in the active conversation",
    category: "conversation",
  },
  lastMessage: {
    id: "lastMessage",
    keys: "shift+g",
    label: "Last message",
    description: "Move to the latest message in the active conversation",
    category: "conversation",
  },
  nextFile: {
    id: "nextFile",
    keys: "]",
    label: "Next changed file",
    description: "Move to the next file in the active diff",
    category: "diff",
  },
  prevFile: {
    id: "prevFile",
    keys: "[",
    label: "Previous changed file",
    description: "Move to the previous file in the active diff",
    category: "diff",
  },
  nextChange: {
    id: "nextChange",
    keys: "n",
    label: "Next change",
    description: "Move to the next hunk in the active diff",
    category: "diff",
  },
  prevChange: {
    id: "prevChange",
    keys: "shift+n",
    label: "Previous change",
    description: "Move to the previous hunk in the active diff",
    category: "diff",
  },
  newSession: {
    id: "newSession",
    keys: "c>s",
    label: "New session",
    description: "Create a session in the current project",
    category: "creation",
  },
  newConversation: {
    id: "newConversation",
    keys: "c>c",
    label: "New conversation",
    description: "Create a conversation in the current session",
    category: "creation",
  },
  newWorkflow: {
    id: "newWorkflow",
    keys: "c>w",
    label: "New workflow",
    description: "Create a workflow from the current context",
    category: "creation",
  },
  activateOpenTab: {
    id: "activateOpenTab",
    keys: "g>1,g>2,g>3,g>4,g>5,g>6,g>7,g>8,g>9",
    label: "Open conversation by position",
    description: "Activate conversation 1 through 9 in the working set",
    category: "conversation",
  },
  closeConversationTab: {
    id: "closeConversationTab",
    keys: "x",
    label: "Close conversation tab",
    description: "Remove the active conversation from the working set",
    category: "conversation",
  },
  exitPanes: {
    id: "exitPanes",
    keys: null,
    label: "Exit panes",
    description: "Return the conversation workspace to a single pane",
    category: "views",
  },
  expandThinkingBlocks: {
    id: "expandThinkingBlocks",
    keys: "shift+e",
    label: "Expand thinking blocks",
    description: "Expand every thinking block in the active conversation",
    category: "conversation",
  },
  collapseThinkingBlocks: {
    id: "collapseThinkingBlocks",
    keys: "shift+c",
    label: "Collapse thinking blocks",
    description: "Collapse every thinking block in the active conversation",
    category: "conversation",
  },
  goProjects: {
    id: "goProjects",
    keys: "g>h",
    label: "Go to projects",
    description: "Open the projects home view",
    category: "navigation",
  },
  switchProject: {
    id: "switchProject",
    keys: "g>p",
    label: "Switch project",
    description: "Open the project switcher",
    category: "navigation",
  },
  switchSession: {
    id: "switchSession",
    keys: "g>s",
    label: "Switch session",
    description: "Open the session switcher",
    category: "navigation",
  },
  goConversations: {
    id: "goConversations",
    keys: "g>c",
    label: "Go to conversations",
    description: "Open the conversation workspace",
    category: "navigation",
  },
  goTickets: {
    id: "goTickets",
    keys: "g>t",
    label: "Go to tickets",
    description: "Open the project ticket view",
    category: "navigation",
  },
  goSpecs: {
    id: "goSpecs",
    keys: "g>r",
    label: "Go to specs and review",
    description: "Open the specification review view",
    category: "navigation",
  },
  openNeedsYou: {
    id: "openNeedsYou",
    keys: "g>a",
    label: "Open Needs You",
    description: "Open work that is waiting for your attention",
    category: "navigation",
  },
  nextConversation: {
    id: "nextConversation",
    keys: "g>j",
    label: "Next conversation",
    description: "Activate the next open conversation",
    category: "conversation",
  },
  prevConversation: {
    id: "prevConversation",
    keys: "g>k",
    label: "Previous conversation",
    description: "Activate the previous open conversation",
    category: "conversation",
  },
  quickTicket: {
    id: "quickTicket",
    keys: "c>t",
    label: "Quick ticket",
    description: "Capture a ticket without leaving the current view",
    category: "creation",
  },
  viewPrevious: {
    id: "viewPrevious",
    keys: "v>v",
    label: "Previous view",
    description: "Return to the previously selected workspace view",
    category: "views",
  },
  viewConversation: {
    id: "viewConversation",
    keys: "v>c",
    label: "Conversation view",
    description: "Show the conversation transcript",
    category: "views",
  },
  viewDiff: {
    id: "viewDiff",
    keys: "v>d",
    label: "Diff view",
    description: "Show the session diff",
    category: "views",
  },
  viewDocuments: {
    id: "viewDocuments",
    keys: "v>o",
    label: "Documents view",
    description: "Show generated and referenced documents",
    category: "views",
  },
  viewAlignment: {
    id: "viewAlignment",
    keys: "v>a",
    label: "Alignment view",
    description: "Show the session alignment charter",
    category: "views",
  },
  viewSpecs: {
    id: "viewSpecs",
    keys: "v>s",
    label: "Specs view",
    description: "Show the session specification workspace",
    category: "views",
  },
  viewArtifact: {
    id: "viewArtifact",
    keys: "v>r",
    label: "Artifact view",
    description: "Show the active workflow artifact",
    category: "views",
  },
  viewSplit: {
    id: "viewSplit",
    keys: "v>f",
    label: "Split 50/50 view",
    description: "Show the conversation and right panel side by side",
    category: "views",
  },
  viewPanes: {
    id: "viewPanes",
    keys: "v>p",
    label: "Panes view",
    description: "Show open conversations side by side",
    category: "views",
  },
  viewSessions: {
    id: "viewSessions",
    keys: "v>s",
    label: "Sessions view",
    description: "Show sessions in the project cockpit",
    category: "views",
  },
  viewBoard: {
    id: "viewBoard",
    keys: "v>b",
    label: "Board view",
    description: "Show tickets as a board",
    category: "views",
  },
  viewList: {
    id: "viewList",
    keys: "v>l",
    label: "List view",
    description: "Show tickets as a list",
    category: "views",
  },
};

export const PROMPT_EDITING_SHORTCUTS: readonly PromptEditingShortcutDefinition[] =
  [
    {
      keys: "ctrl+;",
      label: "Activate one app shortcut",
      description:
        "While the prompt is focused, arm app shortcuts until one complete shortcut is entered",
    },
    {
      keys: "mod+enter",
      label: "Submit prompt",
      description: "Submit the current prompt",
    },
    {
      keys: "ctrl+a",
      label: "Move to line start",
      description: "Move the caret to the start of the current line",
    },
    {
      keys: "ctrl+e",
      label: "Move to line end",
      description: "Move the caret to the end of the current line",
    },
    {
      keys: "ctrl+u",
      label: "Delete to line start",
      description: "Delete from the caret to the start of the current line",
    },
    {
      keys: "ctrl+k",
      label: "Delete to line end",
      description: "Delete from the caret to the end of the current line",
    },
    {
      keys: "ctrl+w",
      label: "Delete previous word",
      description: "Delete the word before the caret",
    },
    {
      keys: "alt+b",
      label: "Move one word backward",
      description: "Move the caret to the start of the previous word",
    },
    {
      keys: "alt+f",
      label: "Move one word forward",
      description: "Move the caret to the end of the next word",
    },
    {
      keys: "alt+d",
      label: "Delete next word",
      description: "Delete the word after the caret",
    },
  ];

/**
 * A comma separates alternative bindings ("g>1,g>2"), but it is also a key a
 * binding can be bound to ("ctrl+shift+,"). It is the separator only where a
 * key could not be: after a modifier's `+`, and at the start of the text,
 * a comma is the key itself.
 */
const ALTERNATIVES_SEPARATOR = /(?<=[^+]),/;

export function getHotkeySequences(keys: string | null): string[][] {
  if (!keys) return [];
  return keys.split(ALTERNATIVES_SEPARATOR).map((sequence) =>
    sequence
      .split(">")
      .map((stroke) => stroke.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isMacOS(): boolean {
  if (typeof navigator === "undefined") return false;
  if ("userAgentData" in navigator) {
    const navigatorWithData = navigator as Navigator & {
      userAgentData?: { platform: string };
    };
    if (navigatorWithData.userAgentData?.platform) {
      return navigatorWithData.userAgentData.platform === "macOS";
    }
  }
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform);
}

const CATEGORY_LABELS: Record<HotkeyCategory, string> = {
  general: "General",
  navigation: "Navigation",
  creation: "Create",
  conversation: "Conversation",
  review: "Review",
  diff: "Diff Review",
  views: "Views",
  development: "Development",
};

export function getCategoryLabel(category: HotkeyCategory): string {
  return CATEGORY_LABELS[category];
}

const NAMED_KEY_LABELS: Record<string, string> = {
  escape: "Esc",
  enter: "Enter",
  space: "Space",
};

function formatStroke(stroke: string): string {
  const mac = isMacOS();
  return stroke
    .split("+")
    .map((part) => {
      if (part === "mod") return mac ? "⌘" : "Ctrl";
      if (part === "ctrl") return mac ? "⌃" : "Ctrl";
      if (part === "alt") return mac ? "⌥" : "Alt";
      if (part === "shift") return mac ? "⇧" : "Shift";
      return NAMED_KEY_LABELS[part] ?? part.toUpperCase();
    })
    .join(" ");
}

export function formatHotkeyDisplay(keys: string | null): string {
  if (!keys) return "Command menu";
  return getHotkeySequences(keys)
    .map((sequence) => sequence.map(formatStroke).join(" then "))
    .join(" / ");
}
