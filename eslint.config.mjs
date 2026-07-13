// For more info, see https://github.com/storybookjs/eslint-plugin-storybook#configuration-flat-config-format
import storybook from "eslint-plugin-storybook";

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";
import css from "@eslint/css";
import betterTailwind from "eslint-plugin-better-tailwindcss";
import tailwindGuardrails from "./eslint-rules/tailwind-guardrails.mjs";

// Surfaces migrated to Tailwind utilities (utility-first BY DESIGN). The Tailwind
// guardrail rules apply ONLY here — they would false-positive on legacy
// BEM/conditional classNames that Stage A intentionally leaves untouched. Append
// a path as each feature wave migrates (mirrors the utility-collisions allowlist
// and the .prettierrc class-sort overrides).
const MIGRATED_UTILITY_FIRST = [
  "src/components/ui/**/*.{ts,tsx}",
  "src/components/markdown/**/*.{ts,tsx}",
  "src/features/projects-index/components/ProjectCard.tsx",
  "src/features/projects-index/ProjectsIndexPage.tsx",
  // Stage B-1 migrated feature surfaces.
  "src/features/config/**/*.{ts,tsx}",
  "src/features/_root/spawn-card/**/*.{ts,tsx}",
  "src/features/workflows-catalog/**/*.{ts,tsx}",
  "src/features/project-detail/composer/**/*.{ts,tsx}",
  "src/features/project-detail/cockpit/**/*.{ts,tsx}",
  // Stage B-2 migrated feature surfaces + shared components.
  "src/features/session/tabs/**/*.{ts,tsx}",
  "src/features/session/dialogs/**/*.{ts,tsx}",
  "src/components/mcp/**/*.{ts,tsx}",
  "src/components/HotkeyHelpModal.tsx",
  "src/components/GlobalHotkeyHelp.tsx",
  "src/components/BranchSelector.tsx",
  "src/components/ContextFillIndicator.tsx",
  "src/components/TddToggle.tsx",
  "src/components/CardContextMenu.tsx",
  "src/components/Topbar.tsx",
  "src/components/WorkRailMain.tsx",
  "src/components/ApprovalGatePanel.tsx",
  "src/components/ConfirmDialog.tsx",
  "src/components/ModelSelector.tsx",
  "src/components/ReasoningLevelSelector.tsx",
  "src/features/session-diff/components/SessionDiffViewer.tsx",
  // Stage B-3 migrated confined feature surfaces (AddConversationMenu is already
  // covered by the session/tabs/** glob above).
  "src/features/project-detail/components/**/*.{ts,tsx}",
  "src/features/project-detail/ProjectDetailView.tsx",
  "src/features/session/sidebar/**/*.{ts,tsx}",
  "src/features/session/debug/**/*.{ts,tsx}",
  "src/features/session/git/**/*.{ts,tsx}",
  "src/features/session/conversation/SessionActionsMenu.tsx",
  "src/features/session/conversation/InfoDetailsPopover.tsx",
  // Stage B-4 conversation/prompt/panes cluster (mirrors the utility-collisions
  // allowlist + the css ratchet; conversation.css/prompt.css/conversation-panes.css
  // dropped to their preserved residuals). src/components + session/conversation
  // entries are file-scoped so still-legacy siblings stay guarded; collab/, prompt/,
  // panes/ migrated wholesale (dir-scoped).
  "src/components/AgentPill.tsx",
  "src/components/AskQuestionPanel.tsx",
  "src/components/BackendToggle.tsx",
  "src/components/ConversationNav.tsx",
  "src/components/CopyMessageButton.tsx",
  "src/components/FocusConfirmationBar.tsx",
  "src/components/ImageAttachmentPreview.tsx",
  "src/components/MessageActions.tsx",
  "src/components/VoiceRecordButton.tsx",
  "src/components/conversation/ConversationPanel.tsx",
  "src/components/conversation/MessageRow.tsx",
  "src/components/conversation/TypingIndicator.tsx",
  "src/components/conversation/EffortLabel.tsx",
  "src/components/conversation/EffortLabel.stories.tsx",
  "src/features/session/conversation/collab/**/*.{ts,tsx}",
  "src/features/session/conversation/ConversationList.tsx",
  "src/features/session/conversation/ConversationMentionChip.tsx",
  "src/features/session/conversation/ConversationMentionChip.stories.tsx",
  "src/features/session/conversation/DocsPanel.tsx",
  "src/features/session/conversation/FileMentionChip.tsx",
  "src/features/session/conversation/GraphWorkflowCard.tsx",
  "src/features/session/conversation/RightPane.tsx",
  "src/features/session/conversation/SpecBrowser.tsx",
  "src/features/session/conversation/SyntheticForkBadge.tsx",
  "src/features/session/prompt/**/*.{ts,tsx}",
  "src/features/session/mobile/MobilePromptToolbar.tsx",
  "src/features/session/mobile/MobilePromptToolbar.stories.tsx",
  "src/features/session/panes/**/*.{ts,tsx}",
  // Stage B-5a globals.css chrome slices. BulkConfirmModal is already covered by
  // the project-detail/components/** glob; the prompt-editor mention popups by
  // session/prompt/**. CreateSessionModal/MobileActionMenu are intentionally
  // omitted (still part-legacy / deferred Family B). The dev-server inline-rgba
  // gaps + the toast/autocomplete gaps are tokenized in tokens.css.
  "src/features/session/conversation/ConversationLinkChip.tsx",
  "src/components/CollapsibleText.tsx",
  "src/components/MergeToast.tsx",
  "src/components/InputNeededToast.tsx",
  "src/components/PromptErrorToast.tsx",
  "src/components/CommandAutocompleteList.tsx",
  "src/components/FileAutocomplete.tsx",
  "src/components/FileAutocompleteList.tsx",
  "src/components/ConversationAutocompleteList.tsx",
  "src/components/TicketAutocompleteList.tsx",
  "src/components/DevServerDrawer.tsx",
  "src/features/session/conversation/DevServersButton.tsx",
  // Stage B-5b agent-capability globals.css chrome slices (drawer shell, MCP panel,
  // capability-panel core). The whole directory is utility-first; this dir entry
  // supersedes the two B-2 stranded-file entries (Conversation/Scoped configs).
  "src/components/agent-capabilities/**/*.{ts,tsx}",
  // Stage B-6 final waves (graph/builder last) + the globals/session/conversation
  // chrome they migrated wholesale. Mirrors the prettier class-sort overrides and
  // the tailwind-utility-collisions allowlist (which the foundation pre-registered).
  // session/debug,git,dialogs,panes,tabs,prompt/sidebar + ConversationPanel/
  // ConversationNav/TddToggle are already covered by earlier-stage globs above.
  // session/mobile/ is MIXED: MobileInfoPanel migrated to utilities (file-scoped
  // below, alongside the B-4 MobilePromptToolbar entry), but MobileBottomBar and
  // MobileSessionView.stories still consume the legacy .cc-tab/.mobile-bottom-bar
  // recipes (deferred graph-context) — they stay guarded, so NO dir glob here.
  "src/features/workflows-builder/**/*.{ts,tsx}",
  "src/features/session-workflow/**/*.{ts,tsx}",
  "src/components/workflow-graph/**/*.{ts,tsx}",
  "src/features/session/mobile/MobileInfoPanel.tsx",
  "src/components/ToolUseGroup.tsx",
  "src/components/CommandIndicator.tsx",
  "src/components/MessageContent.tsx",
  "src/components/MobileActionMenu.tsx",
  "src/components/DebugStructuredCard.tsx",
  "src/components/CopyableId.tsx",
  "src/features/session/conversation/SessionInfoStrip.tsx",
  "src/features/session/conversation/SessionContent.tsx",
  "src/features/session/conversation/LayoutSwitcher.tsx",
  "src/features/session/conversation/InfoStrip.stories.tsx",
  // Primitive-swap remediation wave (integration sync of the foundation's
  // UTILITY_FIRST_PATHS pre-registration). The swap slices re-homed the shared
  // leaf recipes (.btn*/.cc-tab*/.empty-state*/.status-dot/.form-*/.cc-section-*/
  // .cc-primary/.cc-ibtn/.btn-toggle/.cc-checkbox/.cc-toast) onto ui/ primitives or
  // inline utilities. session/conversation/ is now utility-first wholesale (this dir
  // glob supersedes the file-scoped entries above). Toast.tsx is intentionally
  // omitted: its bg-[rgba(20,25,35,0.96)] surface has no design token yet, so
  // no-hardcoded-color would trip — minting the token + swapping the literal is a
  // tokens.css/Toast.tsx edit outside this integration's ownership; tracked as a
  // remediation task (mint token, swap literal, then add Toast.tsx here + .prettierrc).
  "src/features/session/conversation/**/*.{ts,tsx}",
  "src/features/session/ConversationWorkspace.tsx",
  "src/app/projects/[name]/[session]/conflicts/page.tsx",
  // global-workflow-templates library + launch UI: authored utility-first against
  // the design system. Mirrors the .prettierrc class-sort override and the
  // tailwind-utility-collisions UTILITY_FIRST_PATHS allowlist.
  "src/components/WorkflowLaunchForm.tsx",
  "src/features/workflow-templates/**/*.{ts,tsx}",
  // Conversation-compaction UI (context-artifact envelope viewer + inline
  // message viewer): authored utility-first against the design system. Mirrors
  // the .prettierrc class-sort override and the tailwind-utility-collisions
  // UTILITY_FIRST_PATHS allowlist.
  "src/components/context-artifacts/**/*.{ts,tsx}",
  // Live-editing execution-inspector config editors (doc 06 slice 4): shared
  // field editors reused by the builder and the execution inspector. Mirrors the
  // .prettierrc class-sort override and the tailwind-utility-collisions
  // UTILITY_FIRST_PATHS allowlist.
  "src/components/workflow-config/**/*.{ts,tsx}",
  // Ticket-system UI: tickets feature + the promoted session indicator, authored
  // utility-first against the design system. Mirrors the .prettierrc class-sort
  // override and the tailwind-utility-collisions UTILITY_FIRST_PATHS allowlist.
  "src/features/tickets/**/*.{ts,tsx}",
  "src/components/SessionTicketIndicator.tsx",
];

// Foundation/vendor areas where authored global CSS is allowed. Feature `styles/`
// dirs are deliberately NOT here — they are migration debt, so a NEW stylesheet
// there must fail the no-unapproved-global-css guardrail (globals.css/theme.css
// are the Tailwind directive entry points, ignored by the css block below).
const APPROVED_GLOBAL_CSS_AREAS = [
  "/features/_root/styles/", // foundation (tokens, reset, shell, typography, …)
  "/components/workflow-graph/", // React Flow vendor stylesheet
];

// Pre-existing legacy feature stylesheets, grandfathered as debt: they may keep
// their rules (the css:progress ratchet drives the counts down), but the guardrail
// blocks any NEW global CSS file. Do NOT add to this list to make room for new
// global CSS — migrate to utilities instead.
const GRANDFATHERED_LEGACY_CSS = [
  "/features/_root/spawn-card/spawn-card.css",
  "/features/config/styles/config-editor.css",
  "/features/project-detail/cockpit/styles/cockpit.css",
  "/features/project-detail/composer/styles/composer.css",
  "/features/project-detail/styles/project-detail.css",
  "/features/projects-index/styles/projects-index.css",
  "/features/session-diff/styles/session-diff.css",
  "/features/session-workflow/styles/session-workflow.css",
  "/features/session/sidebar/styles/PeekPopover.css",
  "/features/workflows-builder/styles/workflows-builder.css",
  "/features/workflows-catalog/styles/workflows-catalog.css",
];

// Whole-state escape hatches. `readState` hydrates, and `mutateState` /
// `writeState` rewrite, the ENTIRE ManagerState tree on every call — a whole-tree
// cost regardless of how little you touch (PERFORMANCE.md patterns 1–2;
// structural change #2). Focused accessors/setters are the default; importing
// these is the explicit, greppable exception. Only files that genuinely operate
// over the whole tree may import them, each listed here with why. Do NOT add a
// file to make a single-row read/write convenient — add a focused accessor.
const WHOLE_STATE_ALLOWED = [
  "src/instrumentation.node.ts", // startup recovery sweep across all projects/sessions
  "src/lib/projects/discovery.ts", // reconciles the full project/session tree against disk
  "src/lib/sessions/service.ts", // session CRUD + bulk lifecycle over the whole tree
  "src/lib/active-conversations/route-handlers.ts", // cross-project active-conversation aggregation
  "src/lib/debug-log/ingest-route-handlers.ts", // resolves an arbitrary project/session for a debug entry
  "src/lib/conversations/cross-project-list.ts", // lists/finds conversations across every project
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "storybook-static/**",
    ".design-sync/**",
    ".worktrees/**",
    "memory-bank/**",
    "redesign-session-page-handoff/**",
    "next-env.d.ts",
  ]),
  ...storybook.configs["flat/recommended"],
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  // Tailwind migration guardrails on migrated, utility-first surfaces (design 5.2;
  // R7.5/8.3). Plus eslint-plugin-better-tailwindcss for duplicate-class detection.
  {
    files: MIGRATED_UTILITY_FIRST,
    ignores: ["**/*.test.{ts,tsx}"],
    plugins: {
      "tailwind-guardrails": tailwindGuardrails,
      "better-tailwindcss": betterTailwind,
    },
    settings: {
      "better-tailwindcss": { entryPoint: "src/app/globals.css" },
    },
    rules: {
      "tailwind-guardrails/no-dynamic-class": "error",
      "tailwind-guardrails/no-hardcoded-color": "error",
      "tailwind-guardrails/no-appearance-in-layout-classname": "error",
      "better-tailwindcss/no-duplicate-classes": "error",
    },
  },
  // No new global CSS outside approved foundation/vendor areas (design 5.2; R8.4).
  // The Tailwind directive entry points (globals.css/theme.css) are ignored: they
  // are approved anyway and use @theme/@custom-variant syntax the CSS parser need
  // not understand.
  {
    files: ["**/*.css"],
    ignores: ["src/app/globals.css", "src/features/_root/styles/theme.css"],
    language: "css/css",
    languageOptions: { tolerant: true },
    plugins: { css, "tailwind-guardrails": tailwindGuardrails },
    rules: {
      "tailwind-guardrails/no-unapproved-global-css": [
        "error",
        {
          approvedAreas: APPROVED_GLOBAL_CSS_AREAS,
          grandfathered: GRANDFATHERED_LEGACY_CSS,
        },
      ],
    },
  },
  // Focused-first default: importing the whole-state escape hatches is the
  // explicit exception (PERFORMANCE.md patterns 1–2; structural change #2). New
  // importers must reach for a focused accessor or be added to
  // WHOLE_STATE_ALLOWED with a reason. Placed before the collaboration block so
  // that block's own no-restricted-imports config wins for its four files (which
  // do not import whole-state anyway).
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [...WHOLE_STATE_ALLOWED, "**/*.test.{ts,tsx}", "**/*.stories.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/state-store",
                "**/state-store/accessors",
                "**/state-store/store",
              ],
              importNames: ["readState", "mutateState", "writeState"],
              message:
                "readState/mutateState/writeState hydrate or rewrite the ENTIRE ManagerState on every call (PERFORMANCE.md patterns 1–2). Use a focused accessor/setter instead. If you genuinely need the whole tree, add this file to WHOLE_STATE_ALLOWED in eslint.config.mjs with a reason.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/lib/workflows/collaboration/workflow-envelope.ts",
      "src/lib/workflows/collaboration/workflow-envelope.test.ts",
      "src/lib/workflows/collaboration/feature-snapshot.ts",
      "src/lib/workflows/collaboration/feature-snapshot.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/workflows/primitives/human-approval-gate",
              message:
                "Workflow-scoped collaboration must NEVER pause for user input. Report requires_user_input as a structured result instead. See design §Workflow Collaboration Envelope and Requirement 4.1.",
            },
            {
              name: "@/lib/workflows/collaboration/envelope",
              message:
                "Workflow-scoped collaboration must not couple to the user-triggered envelope. Duplicate the round/collaborator-invocation logic locally per design §Envelope Extraction Decision.",
            },
          ],
          patterns: [
            {
              group: [
                "**/workflows/primitives/human-approval-gate",
                "**/workflows/primitives/human-approval-gate.*",
              ],
              message:
                "Workflow-scoped collaboration must NEVER pause for user input. Report requires_user_input as a structured result instead.",
            },
            {
              group: [
                "**/workflows/collaboration/envelope",
                "**/workflows/collaboration/envelope.*",
              ],
              message:
                "Workflow-scoped collaboration must not couple to the user-triggered envelope.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
