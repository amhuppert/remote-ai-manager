import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import UnifiedComposer from "./UnifiedComposer";
import type { ConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { FilterToken } from "../components/filter-tokens";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "true" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    profileSnapshot: null,
    id: "plc-1",
    scope: "project",
    name: "Project chat",
    status: "new",
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    open: true,
    ...overrides,
  });
}

const sessions: SessionListItem[] = [
  {
    sessionName: "implement-auth",
    worktreePath: "/tmp/wt/a",
    branchName: "csm/implement-auth",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    derivedStatus: "running",
    promptCount: 3,
    derivedLastActivityAt: "2026-01-01T00:00:00Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
  },
];

function Harness({
  initialAgent = "claude",
  activeConversationId = "plc-1",
  conversation,
}: {
  initialAgent?: AgentBackendId;
  activeConversationId?: string | null;
  conversation?: ConversationState;
}) {
  const [agent, setAgent] = useState<AgentBackendId>(initialAgent);
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  return (
    <div style={{ maxWidth: 720 }}>
      <UnifiedComposer
        projectName="command-center"
        activeConversationId={activeConversationId}
        activeConversation={conversation}
        agentBackend={agent}
        backendDefaults={BACKEND_DEFAULTS}
        onAgentChange={(next) => {
          setAgent(next);
          fn()(next);
        }}
        tokens={tokens}
        onTokensChange={setTokens}
        sessions={sessions}
        archivedCount={12}
        onSendPrompt={fn(async () => "accepted" as const)}
        onRunCommand={fn()}
        busy={false}
      />
      <div style={{ marginTop: 8, color: "var(--text-tertiary)" }}>
        tokens: {tokens.map((t) => `${t.key}:${t.value}`).join(", ") || "—"}
      </div>
    </div>
  );
}

const meta: Meta<typeof UnifiedComposer> = {
  title: "Project Cockpit/Composer/UnifiedComposer",
  component: UnifiedComposer,
};
export default meta;

type Story = StoryObj<typeof UnifiedComposer>;

/** Pre-init: no conversation yet — backend is selectable, chat create-and-sends. */
export const FirstRunPreInit: Story = {
  render: () => <Harness activeConversationId={null} />,
};

/** Post-init (Claude): an initialized conversation locks the backend control. */
export const PostInitClaude: Story = {
  render: () => <Harness conversation={makeConversation({ promptCount: 4 })} />,
};

/** Codex identity recolors the composer + chip violet; backend locked post-init. */
export const PostInitCodex: Story = {
  render: () => (
    <Harness
      initialAgent="codex"
      conversation={makeConversation({
        promptCount: 4,
        agentBackend: "codex",
      })}
    />
  ),
};

/** Type `/` to open the command palette, or `is:` to add a filter chip. */
export const Interactive: Story = {
  render: () => <Harness conversation={makeConversation({ promptCount: 1 })} />,
};
