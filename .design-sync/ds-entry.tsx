// Synth bundle barrel for /design-sync. Command Center is a Next.js app, not a
// published library, so there is no dist/ — this re-exports the 22 in-scope
// components from source. Registered as cfg.extraEntries (NOT the --entry): the
// converter's export scanner walks extraEntries' *relative* re-exports to learn
// the component names (the storybook shape otherwise discovers exports from a
// package .d.ts, which this app has none of). RELATIVE paths are mandatory — the
// scanner skips `@/`-aliased re-exports. Component-internal `@/` imports still
// resolve via .design-sync/tsconfig.bundle.json (which also stubs @/lib/logging).

// UI primitives (named exports, including sub-components)
export * from "../src/components/ui/Badge";
export * from "../src/components/ui/Button";
export * from "../src/components/ui/EmptyState";
export * from "../src/components/ui/FormField";
// FormField is a compound module (FormGroup/FormLabel/FormInput/FormHint/FormError)
// with no single `FormField` export. The story is titled "UI/FormField" with
// `component: FormInput`. Alias FormInput → FormField so the card keeps the
// recognizable name and documents FormInput's props; the sub-components remain
// available (above) for the composed examples.
export { FormInput as FormField } from "../src/components/ui/FormField";
export * from "../src/components/ui/IconButton";
export * from "../src/components/ui/ModalShell";
export * from "../src/components/ui/SectionHeader";
export * from "../src/components/ui/StatusDot";
export * from "../src/components/ui/Tabs";
// Radix-backed overlay primitives (each module exports its Root wrapper named
// after the story title — DropdownMenu/Select/ContextMenu — plus its sub-parts).
export * from "../src/components/ui/DropdownMenu";
export * from "../src/components/ui/Select";
export * from "../src/components/ui/ContextMenu";

// Generic chrome
export * from "../src/components/ContextFillIndicator";
export { default as CollapsibleText } from "../src/components/CollapsibleText";
export { default as ConfirmDialog } from "../src/components/ConfirmDialog";
export { default as CopyableId } from "../src/components/CopyableId";
export { default as CardContextMenu } from "../src/components/CardContextMenu";
export { default as MarkdownContent } from "../src/components/MarkdownContent";
export { default as ConversationNav } from "../src/components/ConversationNav";
export { default as MergeToast } from "../src/components/MergeToast";
export * from "../src/components/MergeToast";

// App-flavored controls
export { default as ModelSelector } from "../src/components/ModelSelector";
export * from "../src/components/ModelSelector";
export { default as ReasoningLevelSelector } from "../src/components/ReasoningLevelSelector";
export * from "../src/components/ReasoningLevelSelector";
export { default as BackendToggle } from "../src/components/BackendToggle";
export { default as TddToggle } from "../src/components/TddToggle";
export { default as BranchSelector } from "../src/components/BranchSelector";
