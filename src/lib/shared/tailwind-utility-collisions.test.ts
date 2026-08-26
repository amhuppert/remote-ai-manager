/**
 * Visual-inertness guard for the Tailwind integration (requirement 1.3).
 *
 * Tailwind v4 auto-scans the codebase and emits a utility for every token it
 * sees. A token that is (a) a generated Tailwind utility, (b) used as a bare
 * className on an element, and (c) has NO legacy CSS rule, would start applying
 * a style the element never had before — a visual change. (The cascade backstop
 * only protects classNames that DO have a legacy unlayered rule; a className with
 * no rule has nothing to win the cascade against.)
 *
 * Example this guards against: an unstyled label using the conventional
 * "screen reader only" utility class rendered normally before integration, but
 * Tailwind's matching utility would hide it.
 *
 * This test compiles the real `globals.css` through the real `@tailwindcss/postcss`,
 * then asserts there are ZERO such collisions. A new collision (a freshly added
 * bare-token className matching a utility) fails this test; resolve it by renaming
 * the className to a non-utility BEM name in the same change.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import tailwindcss from "@tailwindcss/postcss";
import { describe, it, expect } from "vitest";

const repoRoot = process.cwd();
const srcDir = path.join(repoRoot, "src");

/**
 * Paths (directories or specific files) that are migrated, utility-first BY
 * DESIGN: every className is an intentional Tailwind utility composed via `cn()`
 * (the sanctioned `cn("…", cond && "utility")` pattern from
 * docs/tailwind-conventions.md §1.1) or a static utility map, not a legacy bare
 * class that might collide silently. The bare-token collision heuristic (which
 * exists to protect UN-migrated legacy elements) does not apply to them. As
 * feature waves migrate more surfaces to utilities, append their paths here —
 * same spirit as the css-migration-progress ratchet's per-owner allowlist. File
 * entries (not whole dirs) are used when only one component in a feature folder
 * is migrated so far, keeping its still-legacy siblings under the guard.
 */
const UTILITY_FIRST_PATHS = [
  `${path.sep}components${path.sep}ui${path.sep}`,
  `${path.sep}components${path.sep}markdown${path.sep}`,
  // Pilot slice (design task 5.1): ProjectCard is fully utility-first.
  `${path.sep}features${path.sep}projects-index${path.sep}components${path.sep}ProjectCard.tsx`,
  // Stage B-1 feature waves: each surface migrated wholesale to utilities +
  // shared primitives (their feature `styles/*.css` dropped to its residual
  // floor). composer/cockpit are subdirs of project-detail, so the still-legacy
  // project-detail shell stays under the guard.
  `${path.sep}features${path.sep}config${path.sep}`,
  `${path.sep}features${path.sep}project-detail${path.sep}spawn-card${path.sep}`,
  `${path.sep}features${path.sep}project-detail${path.sep}composer${path.sep}`,
  `${path.sep}features${path.sep}project-detail${path.sep}cockpit${path.sep}`,
  // Stage B-2 migrated feature surfaces + shared components. The src/components
  // entries are file-scoped (their still-legacy siblings stay under the guard).
  `${path.sep}features${path.sep}session${path.sep}tabs${path.sep}`,
  `${path.sep}features${path.sep}session${path.sep}dialogs${path.sep}`,
  `${path.sep}components${path.sep}mcp${path.sep}`,
  `${path.sep}components${path.sep}hotkeys${path.sep}`,
  `${path.sep}components${path.sep}HotkeyHelpModal.tsx`,
  `${path.sep}components${path.sep}GlobalHotkeyHelp.tsx`,
  `${path.sep}components${path.sep}BranchSelector.tsx`,
  `${path.sep}components${path.sep}ContextFillIndicator.tsx`,
  `${path.sep}components${path.sep}TddToggle.tsx`,
  `${path.sep}components${path.sep}CardContextMenu.tsx`,
  `${path.sep}components${path.sep}Topbar.tsx`,
  `${path.sep}components${path.sep}topbar${path.sep}NavSwitchers.tsx`,
  `${path.sep}components${path.sep}topbar${path.sep}QuickTicketButton.tsx`,
  `${path.sep}components${path.sep}topbar${path.sep}QuickTicketButton.stories.tsx`,
  `${path.sep}components${path.sep}topbar${path.sep}NeedsYouMenu.tsx`,
  `${path.sep}components${path.sep}topbar${path.sep}NeedsYouMenu.stories.tsx`,
  `${path.sep}components${path.sep}quick-ticket${path.sep}`,
  `${path.sep}components${path.sep}WorkRailMain.tsx`,
  `${path.sep}components${path.sep}ApprovalGatePanel.tsx`,
  // Stage B-5b agent-capability drawer-shell slice: the whole directory goes
  // utility-first as the cap-*/tabs/configurator/drawer/trigger families are
  // migrated out of globals.css. Dir-scoped (covers the still-in-flight panel
  // slices too — their not-yet-migrated classes stay rule-backed in globals.css,
  // so no bare-token collision exists for the heuristic to catch).
  `${path.sep}components${path.sep}agent-capabilities${path.sep}`,
  // Agent profile library surfaces: authored utility-first from the start (no
  // legacy CSS ever existed for them), so both directories are dir-scoped. The
  // conversation profile chip is file-scoped — its still-legacy siblings under
  // components/conversation/ stay guarded.
  `${path.sep}components${path.sep}agent-profiles${path.sep}`,
  `${path.sep}features${path.sep}agent-profiles${path.sep}`,
  `${path.sep}components${path.sep}conversation${path.sep}ConversationProfileChip.tsx`,
  `${path.sep}features${path.sep}projects-index${path.sep}ProjectsIndexPage.tsx`,
  `${path.sep}components${path.sep}ConfirmDialog.tsx`,
  `${path.sep}components${path.sep}ModelSelectionMetadata.tsx`,
  `${path.sep}components${path.sep}ModelSelector.tsx`,
  `${path.sep}components${path.sep}ReasoningLevelSelector.tsx`,
  // SessionDiffViewer reproduces the session.css/conversation.css diff/commit
  // rules as utilities in its own .tsx (those dense files stay for the sidebar
  // until B-3); fully utility-first.
  `${path.sep}features${path.sep}session-diff${path.sep}components${path.sep}SessionDiffViewer.tsx`,
  // Stage B-3 confined feature surfaces (AddConversationMenu is covered by the
  // session/tabs/ entry above). project-detail/components + ProjectDetailView are
  // file/dir-scoped so the still-legacy project-detail shell stays under the guard.
  `${path.sep}features${path.sep}project-detail${path.sep}components${path.sep}`,
  `${path.sep}features${path.sep}project-detail${path.sep}ProjectDetailView.tsx`,
  `${path.sep}components${path.sep}session${path.sep}sidebar${path.sep}`,
  `${path.sep}features${path.sep}session${path.sep}debug${path.sep}`,
  // The self-contained debug leaves (DebugStatusStrip/DebugModeToggle) promoted
  // out of features/session/debug/ to src/components/session/ — utility-first by
  // design, file-scoped so the components/session/ root isn't blanket-exempted.
  `${path.sep}components${path.sep}session${path.sep}DebugStatusStrip.tsx`,
  `${path.sep}components${path.sep}session${path.sep}DebugModeToggle.tsx`,
  // CollabConfigRow promoted out of features/session/conversation/collab/ (the
  // only collab leaf PromptComposer consumes) to src/components/session/;
  // utility-first by design, file-scoped like the debug leaves above.
  `${path.sep}components${path.sep}session${path.sep}CollabConfigRow.tsx`,
  `${path.sep}components${path.sep}git${path.sep}`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}SessionActionsMenu.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}InfoDetailsPopover.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}ConversationLinkChip.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}MessageRefLinkChip.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}MessageRefLinkChip.stories.tsx`,
  `${path.sep}components${path.sep}CollapsibleText.tsx`,
  // ConversationsPage is NOT utility-first; the sidebar wave migrated only its
  // sidebar-expand-float button to utilities (the `.convo-sidebar-expand-float`
  // rule was deleted from sidebar.css). File-scoped so the page's still-legacy
  // remainder stays under the guard.
  `${path.sep}features${path.sep}session${path.sep}ConversationsPage.tsx`,
  // Stage B-4 conversation/prompt/panes cluster: conversation.css dropped to its
  // preserved floor as these surfaces went utility-first (cn()/static maps). The
  // src/components entries are file-scoped so still-legacy siblings stay guarded;
  // collab/ and session/prompt/ migrated wholesale (dir-scoped).
  `${path.sep}components${path.sep}AgentPill.tsx`,
  `${path.sep}components${path.sep}AskQuestionPanel.tsx`,
  `${path.sep}components${path.sep}BackendToggle.tsx`,
  `${path.sep}components${path.sep}ConversationNav.tsx`,
  `${path.sep}components${path.sep}CopyMessageButton.tsx`,
  `${path.sep}components${path.sep}CopyMessageRefButton.tsx`,
  `${path.sep}components${path.sep}ImageAttachmentPreview.tsx`,
  `${path.sep}components${path.sep}MessageActions.tsx`,
  `${path.sep}components${path.sep}VoiceRecordButton.tsx`,
  `${path.sep}components${path.sep}conversation${path.sep}ConversationPanel.tsx`,
  // ConversationTranscript hosts the transcript body extracted from
  // ConversationPanel — utility-first by design (its banner/state markup moved
  // here from the already-exempt panel).
  `${path.sep}components${path.sep}conversation${path.sep}ConversationTranscript.tsx`,
  `${path.sep}components${path.sep}conversation${path.sep}MessageRow.tsx`,
  `${path.sep}components${path.sep}conversation${path.sep}TypingIndicator.tsx`,
  // BackgroundActivityIndicator sits in the same transcript footer slot as
  // TypingIndicator and reuses its geometry — utility-first by design (cn() +
  // ui/StatusChip + design tokens). Component and story are both exempt.
  `${path.sep}components${path.sep}conversation${path.sep}BackgroundActivityIndicator.tsx`,
  `${path.sep}components${path.sep}conversation${path.sep}BackgroundActivityIndicator.stories.tsx`,
  // EffortLabel (the message-metadata effort cell, shown inside MessageRow) is
  // utility-first by design — `cn()` + design-system tokens + the preserved
  // `cc-rainbow-text` treatment. Both the component and its story are exempt;
  // the component also uses the `text-text-secondary` token, which the story
  // merely reports first (it sorts before the .tsx).
  `${path.sep}components${path.sep}conversation${path.sep}EffortLabel.tsx`,
  `${path.sep}components${path.sep}conversation${path.sep}EffortLabel.stories.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}collab${path.sep}`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}ConversationList.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}ConversationMentionChip.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}ConversationMentionChip.stories.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}MessageMentionChip.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}MessageMentionChip.stories.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}DocsPanel.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}FileMentionChip.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}GraphWorkflowCard.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}RightPane.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}SpecBrowser.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}SyntheticForkBadge.tsx`,
  `${path.sep}components${path.sep}session${path.sep}prompt${path.sep}`,
  `${path.sep}components${path.sep}session${path.sep}MobilePromptToolbar.tsx`,
  `${path.sep}components${path.sep}session${path.sep}MobilePromptToolbar.stories.tsx`,
  // Stage B-4 conversation-panes wave: the split-screen panes frame is fully
  // utility-first (conversation-panes.css dropped to its 3-selector residual).
  `${path.sep}features${path.sep}session${path.sep}panes${path.sep}`,
  // Stage B-5a merge-toast slice: the global toast layer is fully utility-first
  // (the .merge-toast* region was deleted from globals.css; only its keyframes
  // remain as preserved-CSS).
  `${path.sep}components${path.sep}MergeToast.tsx`,
  `${path.sep}components${path.sep}InputNeededToast.tsx`,
  `${path.sep}components${path.sep}PromptErrorToast.tsx`,
  // Stage B-5a autocomplete slice: the .cmd-*/.file-*/.conversation-* autocomplete
  // regions were deleted from globals.css (only the shared cmdReveal keyframe
  // remains as preserved-CSS). The popup consumers fall under the
  // features/session/prompt/ dir entry above.
  `${path.sep}components${path.sep}CommandAutocompleteList.tsx`,
  `${path.sep}components${path.sep}FileAutocomplete.tsx`,
  `${path.sep}components${path.sep}FileAutocompleteList.tsx`,
  // The single file-autocomplete popup-body owner both file-mention surfaces
  // render through — utility-first by design, like the two host files above.
  `${path.sep}components${path.sep}FileAutocompleteListView.tsx`,
  `${path.sep}components${path.sep}ConversationAutocompleteList.tsx`,
  // DevServerDrawer + DevServersButton are utility-first; their only CSS is the
  // ds-panel-in/ds-sheet-in entry keyframes in globals.css (preserved-CSS).
  `${path.sep}components${path.sep}DevServerDrawer.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}DevServersButton.tsx`,
  // Stage B-6 pre-registration (foundation context): all surfaces the parallel
  // B-6 migration waves convert wholesale to utilities are exempted here in one
  // edit so those waves need no further allowlist changes. SAFE: not-yet-migrated
  // files still use rule-backed legacy classes (no bare-token utility collision),
  // so exempting them early is a no-op for the heuristic. Whole folders that
  // migrate wholesale are dir-scoped; the globals-chrome / shared components that
  // migrate file-by-file are file-scoped. (The .collaboration-status-card rule in
  // globals.css is dead — its old consumer was deleted — so it needs no entry.)
  `${path.sep}features${path.sep}workflows-builder${path.sep}`,
  `${path.sep}features${path.sep}session-workflow${path.sep}`,
  `${path.sep}components${path.sep}workflow-graph${path.sep}`,
  // session/mobile/ is now utility-first WHOLESALE. The B-4/B-6 waves migrated
  // MobileInfoPanel/MobilePromptToolbar/MobileSessionView.stories; the primitive-swap
  // remediation wave migrates the last leaf-recipe holdout (MobileBottomBar.tsx's
  // .cc-tabs/.cc-tab recipes → the Tabs primitive), so the whole dir is dir-scoped
  // here (superseding the earlier file-scoping that kept MobileBottomBar guarded).
  `${path.sep}features${path.sep}session${path.sep}mobile${path.sep}`,
  `${path.sep}components${path.sep}ToolUseGroup.tsx`,
  `${path.sep}components${path.sep}CommandIndicator.tsx`,
  // MessageContent.tsx hosts the ToolUseIndicator (the .tool-use-* chrome this
  // B-6 message wave migrated to utilities). The foundation pre-registration
  // omitted it; added here (UTILITY_FIRST_PATHS only — eslint/prettier allowlist
  // sync deferred to integration) so the collision guardrail stays green.
  `${path.sep}components${path.sep}MessageContent.tsx`,
  // ThinkingBlock — the agent-reasoning aside dispatched from MessageContent —
  // is utility-first by design (cn() + design tokens, no legacy classes). Both
  // the component and its story are exempt.
  `${path.sep}components${path.sep}ThinkingBlock.tsx`,
  `${path.sep}components${path.sep}ThinkingBlock.stories.tsx`,
  `${path.sep}components${path.sep}MobileActionMenu.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}SessionInfoStrip.tsx`,
  `${path.sep}components${path.sep}CopyableId.tsx`,
  // Session-chrome slice entries the foundation pre-registration omitted (the
  // SessionInfoStrip host components migrated to utilities). DebugStructuredCard
  // has no bare-token collision so needs no entry here (see b6-session-chrome
  // foundation-gap doc); it is still registered in eslint/prettier for class-sort.
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}SessionContent.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}LayoutSwitcher.tsx`,
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}InfoStrip.stories.tsx`,
  // Primitive-swap remediation wave pre-registration (UTILITY_FIRST_PATHS only;
  // eslint.config.mjs + .prettierrc sync deferred to the integration context). The
  // parallel swap slices re-home each shared leaf recipe (.btn*/.cc-tab*/.empty-state*/
  // .status-dot/.form-*/.cc-section-*/.cc-primary/.cc-ibtn/.btn-toggle/.cc-checkbox/
  // .cc-toast) onto the matching ui/ primitive or inline utilities. SAFE pre-swap:
  // every file below still uses rule-backed legacy classes today (no bare-token
  // collision), so exempting it now is a no-op for the heuristic; the entry takes
  // effect once a slice adds layout utilities. Owned subdirs that go utility-first
  // wholesale are dir-scoped (their existing file-scoped entries above stay valid,
  // just now redundant); the shared globals-chrome consumers are file-scoped.
  `${path.sep}features${path.sep}session${path.sep}conversation${path.sep}`,
  `${path.sep}components${path.sep}Toast.tsx`,
  `${path.sep}components${path.sep}ToastHost.tsx`,
  `${path.sep}features${path.sep}session${path.sep}ConversationWorkspace.tsx`,
  `${path.sep}app${path.sep}projects${path.sep}[name]${path.sep}[session]${path.sep}conflicts${path.sep}page.tsx`,
  // global-workflow-templates library + launch UI: authored utility-first against
  // the design system. Registered in all three mirrored allowlists (here +
  // eslint.config.mjs MIGRATED_UTILITY_FIRST + .prettierrc).
  `${path.sep}components${path.sep}WorkflowLaunchForm.tsx`,
  `${path.sep}features${path.sep}workflow-templates${path.sep}`,
  // markdown-doc-feedback feature: the multi-document viewer and its comment /
  // selection surfaces are authored utility-first against the design system
  // (Groups 4/5/6/8 deferred this allowlist registration to the integration
  // context). The whole feature dir is dir-scoped; the shared transcript
  // additions (file card, its scope provider, and the document-feedback card)
  // are file-scoped.
  `${path.sep}features${path.sep}session${path.sep}document-viewer${path.sep}`,
  `${path.sep}components${path.sep}conversation${path.sep}MarkdownFileCard.tsx`,
  `${path.sep}components${path.sep}conversation${path.sep}document-scope.tsx`,
  `${path.sep}components${path.sep}conversation${path.sep}DocumentFeedbackCard.tsx`,
  // Async-ask answer card: the transcript renderer for <cc-question-answers>
  // blocks, authored utility-first alongside DocumentFeedbackCard.
  `${path.sep}components${path.sep}conversation${path.sep}QuestionAnswersCard.tsx`,
  // Conversation-compaction UI (context-artifact envelope viewer + inline
  // message viewer): authored utility-first against the design system.
  // Registered in all three mirrored allowlists (here + eslint.config.mjs
  // MIGRATED_UTILITY_FIRST + .prettierrc).
  `${path.sep}components${path.sep}context-artifacts${path.sep}`,
  // Live-editing execution-inspector config editors (doc 06 slice 4): the shared
  // field editors extracted to src/components/workflow-config/ for reuse by the
  // builder and the execution inspector are authored utility-first against the
  // design system. Registered in all three mirrored allowlists (here +
  // eslint.config.mjs MIGRATED_UTILITY_FIRST + .prettierrc).
  `${path.sep}components${path.sep}workflow-config${path.sep}`,
  // Lanes-first graph-workflow config panel: the host-aware configuration
  // editor mounted by the builder and the execution page is authored
  // utility-first against the design system. Registered in all three mirrored
  // allowlists (here + eslint.config.mjs MIGRATED_UTILITY_FIRST + .prettierrc).
  `${path.sep}components${path.sep}workflow-config-panel${path.sep}`,
  // Ticket-system UI: the tickets feature and the promoted session indicator
  // are authored utility-first against the design system. Registered in all
  // three mirrored allowlists (here + eslint.config.mjs MIGRATED_UTILITY_FIRST
  // + .prettierrc).
  `${path.sep}features${path.sep}tickets${path.sep}`,
  `${path.sep}components${path.sep}SessionTicketIndicator.tsx`,
  // Shared multiline and rich-prompt controls are authored utility-first.
  `${path.sep}components${path.sep}MultilineInput.tsx`,
  `${path.sep}components${path.sep}MultilineInput.stories.tsx`,
  `${path.sep}components${path.sep}rich-prompt${path.sep}`,
  // Native-SDD surfaces (Spec Studio + the shared reference controls): new
  // features authored utility-first against the design system. Registered in
  // all three mirrored allowlists (here + eslint.config.mjs
  // MIGRATED_UTILITY_FIRST + .prettierrc).
  `${path.sep}components${path.sep}references${path.sep}`,
  `${path.sep}features${path.sep}spec-studio${path.sep}`,
  // Topbar nav switchers (project/session breadcrumb popovers): new component
  // directory authored utility-first against the design system. Registered in
  // all three mirrored allowlists (here + eslint.config.mjs
  // MIGRATED_UTILITY_FIRST + .prettierrc).
  `${path.sep}components${path.sep}topbar${path.sep}`,
];

function srcFiles(ext: string): string[] {
  return readdirSync(srcDir, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(ext))
    .map((rel) => path.join(srcDir, rel));
}

/** Simple single-class utility selectors Tailwind generates (e.g. `flex`, `grid`). */
async function generatedSimpleUtilities(): Promise<Set<string>> {
  const globals = readFileSync(path.join(srcDir, "app/globals.css"), "utf8");
  const result = await postcss([tailwindcss()]).process(globals, {
    from: path.join(srcDir, "app/globals.css"),
  });
  const utils = new Set<string>();
  result.root.walkAtRules("layer", (layerRule) => {
    if (!layerRule.nodes) return;
    if (!/(^|[\s,])utilities(\s|,|$)/.test(layerRule.params)) return;
    layerRule.walkRules((rule) => {
      for (const sel of rule.selectors ?? [rule.selector]) {
        const m = /^\.([a-z][a-z0-9-]*)$/.exec(sel.trim());
        if (m?.[1]) utils.add(m[1]);
      }
    });
  });
  return utils;
}

/** Every class name defined by a rule anywhere in CC's CSS. */
function legacyCssClasses(): Set<string> {
  const classes = new Set<string>();
  for (const file of srcFiles(".css")) {
    const css = readFileSync(file, "utf8");
    for (const m of css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)) {
      if (m[1]) classes.add(m[1]);
    }
  }
  return classes;
}

/** Bare (space/quote-delimited, lowercase) className tokens used in JSX → sample file. */
function jsxClassNameTokens(): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const file of srcFiles(".tsx")) {
    if (UTILITY_FIRST_PATHS.some((p) => file.includes(p))) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(
      /className\s*=\s*(?:"([^"]*)"|\{([^}]*)\})/g,
    )) {
      const strings: string[] = [];
      if (m[1] != null) strings.push(m[1]);
      if (m[2] != null) {
        for (const s of m[2].matchAll(/["'`]([^"'`]*)["'`]/g)) {
          if (s[1] != null) strings.push(s[1]);
        }
      }
      for (const str of strings) {
        for (const tok of str.split(/\s+/)) {
          if (/^[a-z][a-z0-9-]*$/.test(tok) && !tokens.has(tok)) {
            tokens.set(tok, path.relative(repoRoot, file));
          }
        }
      }
    }
  }
  return tokens;
}

describe("Tailwind utility collisions (visual inertness)", () => {
  it("no bare-token className matches a generated utility without a legacy CSS rule", async () => {
    const [utilities, legacy, jsxTokens] = [
      await generatedSimpleUtilities(),
      legacyCssClasses(),
      jsxClassNameTokens(),
    ];

    const collisions: string[] = [];
    for (const [token, file] of jsxTokens) {
      if (utilities.has(token) && !legacy.has(token)) {
        collisions.push(`.${token} (first used in ${file})`);
      }
    }

    expect(
      collisions,
      collisions.length
        ? `Tailwind would silently style these bare classNames (no legacy CSS rule):\n  ${collisions.join("\n  ")}\nRename each to a non-utility BEM name to keep the integration visually inert.`
        : undefined,
    ).toEqual([]);
  }, 20000);
});
