import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import ConversationTab from "./ConversationTab";
import ConversationTabStrip from "./ConversationTabStrip";

// Deterministic fixtures covering every visual state of the conversation-tabs
// surface, used for the Tailwind migration before/after parity capture
// (docs/tailwind-conventions.md §4). Renders the real components with frozen
// data so the migrated (after) and reverted-legacy (before) builds produce
// directly comparable screenshots.

function convo(
  id: string,
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    scope: "session",
    id,
    name: `Conversation ${id}`,
    status: "running",
    lastActivityAt: "2026-06-14T00:00:00.000Z",
    projectName: "command-center",
    projectPath: "/tmp/command-center",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/tmp/command-center/.worktrees/x",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
    sessionName: `session-${id}`,
    branchName: `csm/${id}`,
    ...overrides,
  };
}

const workingSet: SessionActiveConversation[] = [
  convo("a", { name: "auth-refactor", status: "running" }),
  convo("b", { name: "fix-flaky-tests", status: "waiting_for_input" }),
  convo("c", { name: "design-review", status: "awaiting" }),
  convo("d", { name: "spike-new-idea", status: "new" }),
];

const noop = (): void => {};

const meta: Meta = {
  title: "Session/ConversationTabsParity",
  parameters: { layout: "fullscreen" },
};
export default meta;

type Story = StoryObj;

/** The migrated surface: strip (active + status dots + hotkeys) and every
 *  isolated tab state including the rename input. The add-conversation menu is
 *  a shared popup deferred to Stage B-3 (see conversation-tabs.css), so it is
 *  not part of this parity capture. */
export const Surface: Story = {
  render: () => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 32,
        padding: 24,
        background: "var(--bg-base)",
      }}
    >
      <section>
        <ConversationTabStrip
          workingSet={workingSet}
          activeId="a"
          isAtCap={false}
          onActivate={noop}
          onClose={noop}
          onAddClick={noop}
        />
      </section>

      <section>
        <ConversationTabStrip
          workingSet={workingSet}
          activeId="b"
          isAtCap
          onActivate={noop}
          onClose={noop}
          onAddClick={noop}
        />
      </section>

      <section role="tablist" style={{ display: "flex", gap: 8, padding: 8 }}>
        <ConversationTab
          id="x"
          title="active-tab"
          status="running"
          active
          hotkeyHint="G 1"
          onActivate={noop}
          onClose={noop}
        />
        <ConversationTab
          id="y"
          title="inactive-tab-with-a-very-long-name-that-truncates"
          status="waiting_for_input"
          active={false}
          hotkeyHint="G 2"
          onActivate={noop}
          onClose={noop}
        />
        <ConversationTab
          id="z"
          title="editing"
          status="awaiting"
          active={false}
          isEditing
          editValue="renaming this tab"
          onActivate={noop}
          onClose={noop}
        />
      </section>
    </div>
  ),
};
