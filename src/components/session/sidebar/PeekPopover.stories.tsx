import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fn, userEvent, within } from "storybook/test";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type {
  AskQuestionItem,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import PeekPopover from "@/components/session/sidebar/PeekPopover";

const now = new Date("2026-05-15T12:42:00.000Z");
const minutesAgo = (minutes: number) =>
  new Date(now.getTime() - minutes * 60_000).toISOString();

const BASE_CONVERSATION: SessionActiveConversation = {
  scope: "session",
  id: "convo-peek-base",
  name: "Peek and reply popover",
  status: "running",
  lastActivityAt: minutesAgo(3),
  projectName: "command-center",
  projectPath: "/Users/alex/github/command-center",
  sessionName: "peek-replay",
  agentBackend: "codex",
  summary: "Building the sidebar peek popover.",
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: "iteration",
  branchName: "schema-and-deps-foundation",
  worktreePath:
    "/Users/alex/github/command-center/.worktrees/peek-replay-02e449.schema-and-deps-foundation",
  lastActivitySummary: "Wiring the FloatingUI shell.",
  unread: false,
  pendingApproval: null,
};

function buildConversation(
  overrides: Partial<SessionActiveConversation>,
): SessionActiveConversation {
  return {
    ...BASE_CONVERSATION,
    ...overrides,
  };
}

function message(
  role: TranscriptMessage["role"],
  text: string,
  minutes: number,
): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: minutesAgo(minutes),
  };
}

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function useStoryVoiceHealthMock(): void {
  useEffect(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (fetchUrl(input).endsWith("/api/voice/health")) {
        return Promise.resolve(Response.json({ available: false }));
      }
      return originalFetch(input, init);
    }) as typeof window.fetch;

    return () => {
      window.fetch = originalFetch;
    };
  }, []);
}

const DEFAULT_TRANSCRIPT: TranscriptMessage[] = [
  message(
    "user",
    "Create the popover component and keep it presentational.",
    8,
  ),
  message("assistant", "I am wiring the FloatingUI panel and mock states.", 7),
];

const RUNNING_TRANSCRIPT: TranscriptMessage[] = [
  message(
    "user",
    "Run through the schema and dependency foundation tasks.",
    12,
  ),
  message(
    "assistant",
    "Reading active-conversation schemas and story patterns.",
    10,
  ),
  message(
    "assistant",
    "Adding the component test, then the FloatingUI panel.",
    6,
  ),
];

const AWAITING_TRANSCRIPT: TranscriptMessage[] = [
  message("user", "Summarize the remaining work before the next context.", 20),
  message(
    "assistant",
    "The component and CSS are ready for story verification.",
    16,
  ),
];

const SINGLE_SELECT_QUESTION: AskQuestionItem[] = [
  {
    question: "Should I keep the popover open after sending?",
    header: "Popover behavior",
    options: [
      {
        label: "Keep it open",
        description: "Continue watching the transcript tail after reply.",
        recommended: true,
      },
      {
        label: "Close it",
        description: "Return immediately to sidebar triage.",
        recommended: false,
      },
      {
        label: "Ask again later",
        description: "Defer until visual verification is complete.",
        recommended: false,
      },
    ],
    multiSelect: false,
    required: true,
    allowNote: true,
  },
];

const MULTI_SELECT_QUESTION: AskQuestionItem[] = [
  {
    question: "Which verification passes should I run next?",
    header: "Verification",
    options: [
      {
        label: "Typecheck",
        description: "Confirm the component and stories satisfy TypeScript.",
        recommended: true,
      },
      {
        label: "Storybook render",
        description: "Load every status story in the browser.",
        recommended: false,
      },
    ],
    multiSelect: true,
    required: false,
    allowNote: true,
  },
];

interface PeekStoryProps {
  conversation: SessionActiveConversation;
  transcriptMessages: TranscriptMessage[];
}

function PeekStoryFrame({
  conversation,
  transcriptMessages,
}: PeekStoryProps): React.JSX.Element {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  useStoryVoiceHealthMock();

  useLayoutEffect(() => {
    setAnchorEl(anchorRef.current);
  }, []);

  return (
    <div
      style={{
        position: "relative",
        minHeight: 760,
        padding: "110px 0 0 96px",
        background: "var(--bg-void)",
      }}
    >
      <div
        ref={anchorRef}
        style={{
          width: 300,
          minHeight: 70,
          padding: 12,
          border: "1px solid var(--border-strong)",
          borderRadius: "var(--radius-md)",
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
          fontFamily: "var(--font-body)",
          boxShadow: "inset 0 0 0 1px rgba(0, 229, 255, 0.04)",
        }}
      >
        <div
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10,
            color: "var(--text-tertiary)",
            textTransform: "uppercase",
          }}
        >
          Mock sidebar row
        </div>
        <div style={{ marginTop: 6, fontSize: 13 }}>{conversation.name}</div>
      </div>
      <PeekPopover
        anchorEl={anchorEl}
        conversation={conversation}
        transcriptMessages={transcriptMessages}
        onClose={fn()}
        onOpenFull={fn()}
        onReplyText={fn()}
        onAnswerQuestion={fn()}
        onFork={fn()}
      />
    </div>
  );
}

const meta = {
  title: "Session/PeekPopover",
  component: PeekStoryFrame,
  parameters: {
    layout: "fullscreen",
  },
  render: (args) => <PeekStoryFrame {...args} />,
} satisfies Meta<typeof PeekStoryFrame>;

export default meta;
type Story = StoryObj<typeof meta>;

export const New = {
  args: {
    conversation: buildConversation({
      id: "convo-peek-new",
      name: "Draft implementation plan",
      status: "new",
      lastActivityAt: minutesAgo(1),
      lastActivitySummary: "Conversation created.",
    }),
    transcriptMessages: DEFAULT_TRANSCRIPT,
  },
} satisfies Story;

export const Running = {
  args: {
    conversation: buildConversation({
      id: "convo-peek-running",
      name: "Implement FloatingUI popover",
      status: "running",
      lastActivityAt: minutesAgo(2),
      lastActivitySummary: "Streaming component work.",
    }),
    transcriptMessages: RUNNING_TRANSCRIPT,
  },
} satisfies Story;

export const Awaiting = {
  args: {
    conversation: buildConversation({
      id: "convo-peek-awaiting",
      name: "Await visual verification",
      status: "awaiting",
      lastActivityAt: minutesAgo(11),
      lastActivitySummary: "Waiting for the next instruction.",
    }),
    transcriptMessages: AWAITING_TRANSCRIPT,
  },
} satisfies Story;

export const WaitingForInputStructuredSingleSelect = {
  args: {
    conversation: buildConversation({
      id: "convo-peek-wfi-single",
      name: "Resolve popover behavior",
      status: "waiting_for_input",
      lastActivityAt: minutesAgo(4),
      pendingQuestion: "Should I keep the popover open after sending?",
      pendingQuestionId: "question-single",
      pendingQuestions: SINGLE_SELECT_QUESTION,
      lastActivitySummary: "Agent asked for a popover behavior decision.",
    }),
    transcriptMessages: DEFAULT_TRANSCRIPT,
  },
} satisfies Story;

export const WaitingForInputStructuredMultiSelectOther = {
  args: {
    conversation: buildConversation({
      id: "convo-peek-wfi-multi",
      name: "Choose verification passes",
      status: "waiting_for_input",
      lastActivityAt: minutesAgo(5),
      pendingQuestion: "Which verification passes should I run next?",
      pendingQuestionId: "question-multi",
      pendingQuestions: MULTI_SELECT_QUESTION,
      lastActivitySummary: "Agent asked which verification passes to run.",
    }),
    transcriptMessages: RUNNING_TRANSCRIPT,
  },
  play: async () => {
    const body = within(document.body);
    await userEvent.click(await body.findByText("Other"));
    await userEvent.type(
      await body.findByPlaceholderText("Type your answer..."),
      "Run Storybook interaction checks",
    );
  },
} satisfies Story;

export const WaitingForInputFallbackBanner = {
  args: {
    conversation: buildConversation({
      id: "convo-peek-wfi-banner",
      name: "Fallback input banner",
      status: "waiting_for_input",
      lastActivityAt: minutesAgo(9),
      pendingQuestion: "Should I run the migration before updating docs?",
      pendingQuestionId: null,
      pendingQuestions: null,
      lastActivitySummary: "Agent asked a legacy free-text question.",
    }),
    transcriptMessages: AWAITING_TRANSCRIPT,
  },
} satisfies Story;
