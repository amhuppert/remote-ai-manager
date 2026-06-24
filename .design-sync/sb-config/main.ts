import type { StorybookConfig } from "@storybook/nextjs-vite";
import base from "../../.storybook/main";

// Scoped Storybook config for /design-sync. The repo's real .storybook covers
// all ~124 stories; this narrows the `stories` glob to ONLY the 22 in-scope
// design-system components so the converter discovers exactly those (the
// storybook shape derives the component list from the reference build's index).
// Everything else — framework, addons, viteFinal (Tailwind plugin + @/lib/logging
// stub alias) — is inherited verbatim from the real config.

const UI = [
  "Badge",
  "Button",
  "ContextMenu",
  "DropdownMenu",
  "EmptyState",
  "FormField",
  "IconButton",
  "ModalShell",
  "SectionHeader",
  "Select",
  "StatusDot",
  "Tabs",
];

const TOP = [
  "CollapsibleText",
  "ConfirmDialog",
  "CopyableId",
  "CardContextMenu",
  "MarkdownContent",
  "ContextFillIndicator",
  "ConversationNav",
  "MergeToast",
  "ModelSelector",
  "ReasoningLevelSelector",
  "BackendToggle",
  "TddToggle",
  "BranchSelector",
];

// Conversation-panel components (under src/components/conversation/).
const CONVERSATION = ["EffortLabel"];

const config: StorybookConfig = {
  ...base,
  stories: [
    ...UI.map((n) => `../../src/components/ui/${n}.stories.tsx`),
    ...TOP.map((n) => `../../src/components/${n}.stories.tsx`),
    ...CONVERSATION.map(
      (n) => `../../src/components/conversation/${n}.stories.tsx`,
    ),
  ],
  staticDirs: ["../../public"],
};

export default config;
