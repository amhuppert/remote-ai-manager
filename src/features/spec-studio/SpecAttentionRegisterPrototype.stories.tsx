import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { CompactMarkdown } from "@/components/markdown/Markdown";
import { StatusChip } from "@/components/ui/StatusChip";
import type { ActorProvenance } from "@/lib/specs/schemas";
import type {
  SpecAssumptionView,
  SpecQuestionView,
} from "@/lib/specs/view-schemas";

import SpecAttentionRegisterPrototype from "./SpecAttentionRegisterPrototype";

const NOW = "2026-08-22T14:20:00.000Z";
const EARLIER = "2026-08-22T13:05:00.000Z";
const HASH = "a".repeat(64);
const CLAUDE: ActorProvenance = {
  kind: "agent",
  conversationId: "conversation-claude-author",
  backend: "claude",
};
const CODEX: ActorProvenance = {
  kind: "agent",
  conversationId: "conversation-codex-editor",
  backend: "codex",
};
const OPERATOR: ActorProvenance = { kind: "human" };
const ELEMENT_HANDLES = new Map([
  ["requirement-1", "R1"],
  ["requirement-3", "R3"],
]);

function question(
  handle: string,
  overrides: Partial<SpecQuestionView> = {},
): SpecQuestionView {
  const number = Number(handle.slice(1));
  return {
    id: `question-${number}`,
    number,
    handle,
    elementId: "requirement-1",
    text: "Which failure contract applies when the upstream service times out?",
    recordVersion: 1,
    status: "open",
    answer: null,
    answeredAt: null,
    withdrawnAt: null,
    provenance: CLAUDE,
    presentation: {
      state: "current",
      attentionActive: true,
      lastMutation: null,
      humanCapability: { kind: "answer", allowed: true },
    },
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function assumption(
  handle: string,
  overrides: Partial<SpecAssumptionView> = {},
): SpecAssumptionView {
  const number = Number(handle.slice(1));
  return {
    id: `assumption-${number}`,
    number,
    handle,
    elementId: "requirement-3",
    text: "Cache invalidation may lag the durable write by up to five seconds.",
    recordVersion: 1,
    disposition: "proposed",
    disposedAt: null,
    withdrawnAt: null,
    proposedBy: CLAUDE,
    supersedesHandle: null,
    supersededByHandle: null,
    currentDraftCitations: null,
    presentation: {
      state: "current",
      attentionActive: true,
      lastMutation: null,
      humanCapability: { kind: "dispose", allowed: true },
    },
    createdAt: EARLIER,
    updatedAt: EARLIER,
    ...overrides,
  };
}

function citedAssumption(
  handle: string,
  overrides: Partial<SpecAssumptionView> = {},
): SpecAssumptionView {
  const base = assumption(handle, overrides);
  return {
    ...base,
    currentDraftCitations: {
      revisionId: "revision-4",
      citationVersion: 3,
      citationHash: HASH,
      citations: [
        {
          revisionId: "revision-4",
          specId: "spec-native-sdd",
          elementId: "requirement-3",
          elementHandle: "R3",
          assumptionId: base.id,
          snapshot: {
            schemaVersion: 1,
            captureKind: "native",
            capturedAt: NOW,
            assumptionId: base.id,
            number: base.number,
            recordVersion: base.recordVersion,
            text: base.text,
            elementId: base.elementId,
            proposedBy: base.proposedBy ?? CLAUDE,
            disposition: base.disposition,
            disposedAt: base.disposedAt,
            withdrawnAt: base.withdrawnAt,
            supersedesAssumptionId:
              base.supersedesHandle === null
                ? null
                : `assumption-${base.supersedesHandle.slice(1)}`,
            createdAt: base.createdAt,
            updatedAt: base.updatedAt,
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    },
  };
}

const editedQuestion = question("Q3", {
  text: "Which **typed refusal** is returned after an upstream timeout?",
  recordVersion: 2,
  presentation: {
    state: "current",
    attentionActive: true,
    lastMutation: {
      operation: "edited",
      actor: CODEX,
      occurredAt: NOW,
    },
    humanCapability: { kind: "answer", allowed: true },
  },
  updatedAt: NOW,
});

const proposedAssumption = citedAssumption("A8", {
  supersedesHandle: "A4",
  presentation: {
    state: "current",
    attentionActive: true,
    lastMutation: {
      operation: "proposed",
      actor: CLAUDE,
      occurredAt: NOW,
    },
    humanCapability: { kind: "dispose", allowed: true },
  },
});

const withdrawnQuestion = question("Q2", {
  status: "withdrawn",
  withdrawnAt: NOW,
  recordVersion: 2,
  presentation: {
    state: "history",
    attentionActive: false,
    lastMutation: {
      operation: "withdrawn",
      actor: CODEX,
      occurredAt: NOW,
    },
    humanCapability: {
      kind: "answer",
      allowed: false,
      code: "terminal",
      blockingRevisionId: null,
      instruction: "This question has a terminal answer or withdrawal.",
    },
  },
  updatedAt: NOW,
});

const supersededAssumption = assumption("A4", {
  disposition: "confirmed",
  disposedAt: "2026-08-21T19:12:00.000Z",
  supersededByHandle: "A8",
  presentation: {
    state: "history",
    attentionActive: false,
    lastMutation: {
      operation: "superseded",
      actor: CODEX,
      occurredAt: NOW,
    },
    humanCapability: {
      kind: "dispose",
      allowed: false,
      code: "terminal",
      blockingRevisionId: null,
      instruction:
        "This assumption is terminal; correct it through supersession.",
    },
  },
  updatedAt: NOW,
});

const baseArgs = {
  projectName: "command-center",
  slug: "native-sdd",
  revision: 4,
  phase: { primary: "draft" as const, authoringStage: "requirements" as const },
  questions: [editedQuestion],
  assumptions: [proposedAssumption],
  history: [
    { kind: "question" as const, record: withdrawnQuestion },
    { kind: "assumption" as const, record: supersededAssumption },
  ],
  elementHandlesById: ELEMENT_HANDLES,
  historyReasonsById: {
    [withdrawnQuestion.id]: "The timeout contract moved into requirement R3.",
    [supersededAssumption.id]:
      "The bounded-lag premise replaces the unbounded cache claim.",
  },
  onAnswerQuestion: fn().mockResolvedValue(undefined),
  onDisposeAssumption: fn().mockResolvedValue(undefined),
};

const meta = {
  title: "Spec Studio/Attention Register Prototype",
  component: SpecAttentionRegisterPrototype,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-bg-void px-xl py-xl max-768:px-md max-768:py-lg">
        <div className="mx-auto max-w-[1180px]">
          <Story />
        </div>
      </main>
    ),
  ],
  args: baseArgs,
} satisfies Meta<typeof SpecAttentionRegisterPrototype>;

export default meta;
type Story = StoryObj<typeof meta>;

export const EditedOpenQuestion: Story = {
  args: { assumptions: [], history: [] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const answer = canvas.getByRole("textbox", { name: "Answer" });
    await userEvent.type(
      answer,
      "Return `upstream_timeout`.{Enter}Preserve the retry token.",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Record answer for Q3" }),
    );
    await expect(args.onAnswerQuestion).toHaveBeenCalledWith({
      questionId: editedQuestion.id,
      recordVersion: 2,
      answer: "Return `upstream_timeout`.\nPreserve the retry token.",
    });
  },
};

export const AgentProposedAssumption: Story = {
  args: { questions: [], history: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const confirm = canvas.getByRole("radio", { name: "Confirm" });
    await userEvent.click(confirm);
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard(" ");
    await expect(canvas.getByRole("radio", { name: "Reject" })).toBeChecked();
    await expect(
      canvas.getByRole("button", { name: "Reject assumption for A8" }),
    ).toBeEnabled();
  },
};

export const HumanDisposedAssumption: Story = {
  args: {
    questions: [],
    history: [],
    assumptions: [
      assumption("A1", {
        text: "Durable state is available before the response is emitted.",
        disposition: "confirmed",
        disposedAt: NOW,
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: {
            operation: "disposed",
            actor: OPERATOR,
            occurredAt: NOW,
          },
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction:
              "This assumption is terminal; correct it through supersession.",
          },
        },
      }),
      citedAssumption("A2", {
        text: "Retries cannot observe a stale record version.",
        disposition: "rejected",
        disposedAt: NOW,
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: {
            operation: "disposed",
            actor: OPERATOR,
            occurredAt: NOW,
          },
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction:
              "This assumption is terminal; correct it through supersession.",
          },
        },
      }),
      assumption("A3", {
        text: "Cross-process eviction can wait for the next operational slice.",
        disposition: "deferred",
        disposedAt: NOW,
        presentation: {
          state: "current",
          attentionActive: false,
          lastMutation: {
            operation: "disposed",
            actor: OPERATOR,
            occurredAt: NOW,
          },
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "terminal",
            blockingRevisionId: null,
            instruction:
              "This assumption is terminal; correct it through supersession.",
          },
        },
      }),
    ],
    blockingAssumptionIds: ["assumption-2"],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryAllByRole("radio")).toHaveLength(0);
    await expect(
      canvas.queryByRole("button", { name: /assumption$/ }),
    ).not.toBeInTheDocument();
    await expect(canvas.getByText("Blocks sign-off")).toBeInTheDocument();
  },
};

export const WithdrawnRecord: Story = {
  args: {
    questions: [],
    assumptions: [],
    history: [{ kind: "question", record: withdrawnQuestion }],
    initiallyOpenHistory: true,
  },
};

export const SupersessionChain: Story = {
  args: {
    questions: [],
    assumptions: [proposedAssumption],
    history: [{ kind: "assumption", record: supersededAssumption }],
    initiallyOpenHistory: true,
  },
};

export const RecordHistoryCollapsed: Story = {
  args: { questions: [], assumptions: [], initiallyOpenHistory: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const disclosure = canvas.getByRole("button", {
      name: "Record history · 2",
    });
    disclosure.focus();
    await userEvent.keyboard("{Enter}");
    await expect(disclosure).toHaveAttribute("aria-expanded", "true");
    await userEvent.keyboard(" ");
    await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  },
};

export const RecordHistoryExpanded: Story = {
  args: { questions: [], assumptions: [], initiallyOpenHistory: true },
};

export const EmptyHistory: Story = {
  args: { questions: [editedQuestion], assumptions: [], history: [] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Record history · 0")).toBeInTheDocument();
    await expect(
      canvas.queryByRole("button", { name: /Record history/ }),
    ).not.toBeInTheDocument();
  },
};

export const MutationPending: Story = {
  args: {
    initialAnswerDrafts: {
      [editedQuestion.id]: "Keep this draft while pending.",
    },
    onAnswerQuestion: fn(() => new Promise<void>(() => undefined)),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Record answer for Q3" }),
    );
    await expect(
      canvas.getByRole("button", { name: "Recording…" }),
    ).toBeDisabled();
    await expect(canvas.getByRole("radio", { name: "Confirm" })).toBeEnabled();
  },
};

export const MutationFailureRetainsDraft: Story = {
  args: {
    questions: [],
    initialDispositionChoices: { [proposedAssumption.id]: "rejected" },
    onDisposeAssumption: fn(async () => {
      throw new Error("The citation version changed; re-read A8 and retry.");
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Reject assumption for A8" }),
    );
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The citation version changed; re-read A8 and retry.",
    );
    await expect(canvas.getByRole("radio", { name: "Reject" })).toBeChecked();
  },
};

export const ImportedAndLegacyProvenance: Story = {
  args: {
    questions: [
      question("Q5", {
        text: "Legacy question with no valid actor envelope.",
        provenance: null,
        presentation: {
          state: "current",
          attentionActive: true,
          lastMutation: null,
          humanCapability: { kind: "answer", allowed: true },
        },
      }),
    ],
    assumptions: [
      assumption("A6", {
        text: "The imported contract already includes a recovery bound.",
        presentation: {
          state: "current",
          attentionActive: true,
          lastMutation: {
            operation: "imported",
            actor: CLAUDE,
            occurredAt: NOW,
          },
          humanCapability: { kind: "dispose", allowed: true },
        },
      }),
    ],
    history: [],
  },
};

export const AbandonedReadOnly: Story = {
  args: {
    questions: [
      question("Q3", {
        presentation: {
          state: "current",
          attentionActive: true,
          lastMutation: null,
          humanCapability: {
            kind: "answer",
            allowed: false,
            code: "read_only",
            blockingRevisionId: null,
            instruction:
              "This spec is abandoned and its attention register is read-only.",
          },
        },
      }),
    ],
    assumptions: [
      assumption("A8", {
        presentation: {
          state: "current",
          attentionActive: true,
          lastMutation: null,
          humanCapability: {
            kind: "dispose",
            allowed: false,
            code: "read_only",
            blockingRevisionId: null,
            instruction:
              "This spec is abandoned and its attention register is read-only.",
          },
        },
      }),
    ],
    history: [],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("textbox")).not.toBeInTheDocument();
    await expect(canvas.queryAllByRole("radio")).toHaveLength(0);
  },
};

export const HistoricalDeepLink: Story = {
  args: {
    questions: [],
    assumptions: [proposedAssumption],
    history: [{ kind: "assumption", record: supersededAssumption }],
    initiallyOpenHistory: false,
    targetHandle: "A4",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("button", { name: "Record history · 1" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(canvas.getByRole("article", { name: /A4/ })).toHaveFocus();
  },
};

export const RevisionPinnedCitation: Story = {
  args: {
    questions: [],
    assumptions: [
      citedAssumption("A8", {
        text: "Current premise: invalidation completes within one second.",
      }),
    ],
    history: [],
  },
  render: (args) => (
    <div className="grid gap-lg">
      <section
        aria-labelledby="revision-citation-heading"
        className="rounded-lg border border-solid border-border-subtle bg-bg-surface p-md"
      >
        <div className="flex flex-wrap items-center gap-sm">
          <h2
            id="revision-citation-heading"
            className="m-0 font-display text-[0.92rem] font-bold text-text-primary"
          >
            Review citation
          </h2>
          <StatusChip tone="cyan">Revision 3 · frozen</StatusChip>
        </div>
        <div className="mt-sm rounded-md border border-solid border-border-dim bg-bg-base px-md py-sm text-[0.84rem]">
          <CompactMarkdown content="Frozen premise: invalidation may lag the durable write by **five seconds**." />
        </div>
        <p className="mt-sm mb-0 font-mono text-[0.7rem] text-text-tertiary">
          Review reads the selected revision snapshot, not the current A8 text
          below.
        </p>
      </section>
      <SpecAttentionRegisterPrototype {...args} />
    </div>
  ),
};

export const Mobile390: Story = {
  args: {
    questions: [editedQuestion],
    assumptions: [
      citedAssumption("A8", {
        text: "A long premise wraps safely: cache invalidation may lag the durable write while another process refreshes a revision-pinned citation.",
      }),
    ],
    history: [{ kind: "assumption", record: supersededAssumption }],
    initiallyOpenHistory: true,
  },
  parameters: {
    viewport: {
      viewports: {
        mobile390: {
          name: "Mobile 390×844",
          styles: { width: "390px", height: "844px" },
        },
      },
      defaultViewport: "mobile390",
    },
  },
};

export const RequirementsStage: Story = {
  args: {
    history: [],
    phase: { primary: "draft", authoringStage: "requirements" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Requirements active")).toBeInTheDocument();
    await expect(
      canvas.getByText(
        "Design remains locked until the requirements stage is settled.",
      ),
    ).toBeInTheDocument();
  },
};
