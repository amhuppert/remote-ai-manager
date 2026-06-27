import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import AlignmentPanelView from "@/features/session/conversation/AlignmentPanelView";
import type {
  AlignmentDecision,
  AlignmentState,
  AlignmentVersion,
} from "@/lib/session-alignment/schemas";

function version(overrides: Partial<AlignmentVersion> = {}): AlignmentVersion {
  return {
    id: "v1",
    version: 1,
    content:
      "# Mission\nKeep every conversation in this session working toward one shared outcome.\n\n## Constraints\n- App state is the source of truth.\n- Conflicts resolve via the stated hierarchy and active decisions.",
    contentHash: "hash-1",
    status: "active",
    source: "align_initial",
    authorConversationId: "conv-1",
    autoActivate: false,
    linkedDecisionIds: [],
    createdAt: "2026-06-26T12:00:00.000Z",
    activatedAt: "2026-06-26T12:00:00.000Z",
    approver: "alex",
    ...overrides,
  };
}

function decision(
  overrides: Partial<AlignmentDecision> = {},
): AlignmentDecision {
  return {
    id: "dec-1",
    statement:
      "Persist alignment state in dedicated tables, app state authoritative.",
    rationale: null,
    originConversationId: "conv-1",
    originMessageId: "msg-1",
    producedVersion: 2,
    approver: "alex",
    approvedAt: "2026-06-26T13:00:00.000Z",
    createdAt: "2026-06-26T13:00:00.000Z",
    ...overrides,
  };
}

function state(overrides: Partial<AlignmentState> = {}): AlignmentState {
  return {
    active: null,
    draft: null,
    history: [],
    decisions: [],
    pendingProposals: [],
    preview: null,
    ...overrides,
  };
}

const meta = {
  title: "Session/AlignmentPanelView",
  component: AlignmentPanelView,
  args: {
    isLoading: false,
    onSelectDiff: fn(),
    onRollback: fn(),
    onNavigateToMessage: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          width: "440px",
          height: "640px",
          background: "var(--bg-base)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AlignmentPanelView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty = {
  args: { state: state() },
} satisfies Story;

export const Loading = {
  args: { state: null, isLoading: true },
} satisfies Story;

export const ActiveOnly = {
  args: {
    state: state({
      active: version({ version: 1 }),
      history: [version({ version: 1 })],
      preview:
        "<session-charter>\nThis governs the session; conflicts resolve via its hierarchy and active decisions.\n\nMission: keep every conversation aligned.\n</session-charter>",
    }),
  },
} satisfies Story;

export const ActiveWithDraft = {
  args: {
    state: state({
      active: version({ version: 1 }),
      draft: version({
        id: "draft-1",
        version: null,
        status: "draft",
        content:
          "# Mission (draft)\nRefine the shared outcome based on the latest discussion.",
      }),
      history: [version({ version: 1 })],
    }),
  },
} satisfies Story;

const v1 = version({
  id: "v1",
  version: 1,
  status: "superseded",
  content: "# Mission\nFirst-cut shared outcome.",
});
const v2 = version({
  id: "v2",
  version: 2,
  status: "active",
  content: "# Mission\nSharpened shared outcome after a decision.",
});

export const FullHistory = {
  args: {
    state: state({
      active: v2,
      history: [v2, v1],
      decisions: [
        decision({
          id: "dec-2",
          statement:
            "Guarantee per-turn charter propagation via runtime recreation.",
          approvedAt: "2026-06-26T14:00:00.000Z",
          producedVersion: 2,
        }),
        decision({ id: "dec-1", producedVersion: null }),
      ],
      preview:
        "<session-charter>\nThis governs the session; conflicts resolve via its hierarchy and active decisions.\n\nMission: sharpened shared outcome after a decision.\n</session-charter>",
    }),
  },
} satisfies Story;

export const WithDiff = {
  args: {
    state: state({ active: v2, history: [v2, v1] }),
    diff: {
      from: 1,
      to: 2,
      fromContent: "# Mission\nFirst-cut shared outcome.",
      toContent: "# Mission\nSharpened shared outcome after a decision.",
    },
  },
} satisfies Story;
