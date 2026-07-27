import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { useState } from "react";
import ProjectCockpit from "./ProjectCockpit";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import type {
  AskQuestionItem,
  ConversationState,
} from "@/lib/conversations/schemas";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { FilterToken } from "../components/filter-tokens";
import { withSeededQueryClient } from "./story-support";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import "./styles/cockpit.css";

const PROJECT = "command-center";
const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", effort: "medium" },
  codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
};

function makeConversation(
  id: string,
  o: Partial<ConversationState> = {},
): ConversationState {
  return {
    id,
    scope: "project",
    name: id,
    transcriptPath: null,
    status: "new",
    promptCount: 2,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    open: true,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    unread: false,
    pendingQueue: [],
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    agentBackend: "claude",
    backendRef: null,
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
    ...o,
  };
}

const openConversations: ConversationState[] = [
  makeConversation("auth-refactor", { name: "Auth refactor" }),
  makeConversation("parser-bug", { name: "Parser bug", unread: true }),
];

// A question batch as the ask route persists it on the conversation row. The
// panel below is hydrated from these durable fields alone — no live event.
const pendingQuestions: AskQuestionItem[] = [
  {
    id: "storage",
    question: "Where should the refreshed token live?",
    header: "Storage",
    options: [
      {
        label: "httpOnly cookie",
        description: "Not readable from JS; needs a same-site policy.",
        recommended: true,
        tradeoff: {
          pro: "Immune to XSS token theft",
          con: "Harder to use from a native client",
        },
      },
      {
        label: "In-memory only",
        description: "Lost on reload; every refresh re-authenticates.",
        recommended: false,
      },
    ],
    multiSelect: false,
    required: true,
    allowNote: true,
  },
  {
    id: "rollout",
    question: "Which callers should move first?",
    header: "Rollout",
    options: [
      { label: "Web app", recommended: false },
      { label: "CLI", recommended: false },
      { label: "Background jobs", recommended: false },
    ],
    multiSelect: true,
    required: false,
    allowNote: false,
  },
];

const waitingConversations: ConversationState[] = [
  makeConversation("auth-refactor", {
    name: "Auth refactor",
    status: "waiting_for_input",
    pendingQuestionId: "q_ask_1",
    pendingQuestions,
  }),
  makeConversation("parser-bug", { name: "Parser bug", unread: true }),
];

const messages: TranscriptMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Refactor the auth module." }],
    timestamp: "2026-01-01T00:00:00Z",
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Mapping the current flow first." }],
    timestamp: "2026-01-01T00:00:05Z",
    model: "opus",
    effort: "high",
  },
];

const sessions: SessionListItem[] = [
  {
    sessionName: "implement-auth",
    worktreePath: "/tmp/wt/a",
    branchName: "csm/implement-auth",
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-02T00:00:00Z",
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    derivedStatus: "running",
    promptCount: 3,
    derivedLastActivityAt: "2026-01-02T00:00:00Z",
    collabContribution: null,
    hasActiveGraphWorkflow: false,
  },
];

function RailStub() {
  return (
    <div
      style={{
        padding: 12,
        fontFamily: "var(--font-mono)",
        fontSize: "0.72rem",
        color: "var(--text-tertiary)",
      }}
    >
      Active Conversations rail
    </div>
  );
}

function Harness({
  conversations = openConversations,
}: {
  conversations?: ConversationState[];
}) {
  const [tokens, setTokens] = useState<FilterToken[]>([]);
  const [backend, setBackend] = useState<AgentBackendId>("claude");
  return (
    <div style={{ height: 640 }}>
      <ProjectCockpit
        projectName={PROJECT}
        openConversations={conversations}
        conversationCreations={conversations.map((c) => ({
          conversationId: c.id,
          creationRequestId: null,
        }))}
        sessions={sessions}
        archivedCount={4}
        tokens={tokens}
        onTokensChange={setTokens}
        onRunCommand={fn()}
        selectedBackend={backend}
        onSelectedBackendChange={setBackend}
        backendDefaults={BACKEND_DEFAULTS}
        rail={<RailStub />}
      />
    </div>
  );
}

const meta: Meta<typeof ProjectCockpit> = {
  title: "Project Cockpit/ProjectCockpit",
  component: ProjectCockpit,
  decorators: [
    withSeededQueryClient([
      [projectConversationKeys.messages(PROJECT, "auth-refactor"), messages],
      [projectConversationKeys.messages(PROJECT, "parser-bug"), []],
    ]),
  ],
};
export default meta;

type Story = StoryObj<typeof ProjectCockpit>;

export const ThreeColumn: Story = {
  render: () => <Harness />,
};

/**
 * The active conversation is `waiting_for_input` with a persisted question
 * batch, so the shared Ask Question panel takes the composer's place.
 */
export const PendingQuestion: Story = {
  render: () => <Harness conversations={waitingConversations} />,
};
