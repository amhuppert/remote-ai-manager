import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import WorkflowCard from "./WorkflowCard";
import type { MachineSpec } from "../machine-spec-types";

/**
 * Storybook fixtures: minimal hand-crafted specs that exercise WorkflowCard's
 * surface (machineId, character, name, tagline, and the 5-stat strip). The
 * production specs are server-only because they import the live XState
 * machines, so stories can't import them. The numbers below are pinned by the
 * `machine-specs.test.ts` snapshot — update both together.
 */

function fixture(
  partial: Pick<
    MachineSpec,
    "id" | "name" | "machineId" | "character" | "tagline"
  > & {
    states: number;
    eventTypes: string[];
    actors: number;
    guards: number;
    actions: number;
  },
): MachineSpec {
  const dummyEvents = partial.eventTypes.map((evt) => ({ event: evt }));
  return {
    id: partial.id,
    name: partial.name,
    machineId: partial.machineId,
    character: partial.character,
    tagline: partial.tagline,
    description: "",
    filePath: "",
    initialState: "",
    states: Array.from({ length: partial.states }, (_, i) => ({
      id: `state-${i}`,
      label: `state-${i}`,
      kind: "atomic" as const,
      events: i === 0 ? dummyEvents : [],
    })),
    actors: Array.from({ length: partial.actors }, (_, i) => ({
      name: `actor-${i}`,
      description: "",
    })),
    guards: Array.from({ length: partial.guards }, (_, i) => ({
      name: `guard-${i}`,
      description: "",
    })),
    actions: Array.from({ length: partial.actions }, (_, i) => ({
      name: `action-${i}`,
      description: "",
    })),
  };
}

const conversationFixture = fixture({
  id: "conversation",
  name: "Conversation",
  machineId: "conversation",
  character: "hierarchical",
  tagline:
    "The full life of a conversation turn — prompt → SDK → ask question → finalize.",
  states: 14,
  eventTypes: [
    "SUBMIT_PROMPT",
    "ENTER_DEBUG_MODE",
    "EXTERNAL_TURN_STARTED",
    "EXTERNAL_TURN_COMPLETED",
    "PROMPT_COMPLETED",
    "PROMPT_FAILED",
    "ABORT_TURN",
    "BACKEND_INIT",
    "ASK_QUESTION",
    "ANSWER",
    "EXIT_DEBUG_MODE",
    "SET_DEBUG_RECORDING",
    "CLEAR_DEBUG_LOGS",
    "MARK_REPRODUCED",
    "MARK_FIX_VERIFIED",
  ],
  actors: 2,
  guards: 8,
  actions: 7,
});

const smartMergeFixture = fixture({
  id: "smart-merge",
  name: "Smart Merge",
  machineId: "smartMerge",
  character: "pipeline · loop",
  tagline:
    "Auto-resolves conflicts, validates, fixes failures, then squashes — or surfaces conflicts.",
  states: 16,
  eventTypes: [],
  actors: 8,
  guards: 8,
  actions: 1,
});

const smartCommitFixture = fixture({
  id: "smart-commit",
  name: "Smart Commit",
  machineId: "smartCommit",
  character: "linear · loop",
  tagline: "Commit, validate, auto-fix on failure, then re-validate.",
  states: 8,
  eventTypes: [],
  actors: 4,
  guards: 3,
  actions: 1,
});

const optimisticFixture = fixture({
  id: "optimistic",
  name: "Optimistic",
  machineId: "optimistic",
  character: "linear",
  tagline:
    "Execute a prompt autonomously, then dispatch a merge — the simplest workflow.",
  states: 4,
  eventTypes: [],
  actors: 2,
  guards: 0,
  actions: 1,
});

const retryFixture = fixture({
  id: "retry",
  name: "Retry",
  machineId: "retry",
  character: "factory · cycle",
  tagline:
    "Generic attempt → fix → reattempt cycle. A reusable child machine for any workflow.",
  states: 4,
  eventTypes: [],
  actors: 2,
  guards: 1,
  actions: 0,
});

const meta = {
  title: "Workflows/WorkflowCard",
  component: WorkflowCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 380 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Conversation = {
  args: { spec: conversationFixture },
} satisfies Story;

export const SmartMerge = {
  args: { spec: smartMergeFixture },
} satisfies Story;

export const SmartCommit = {
  args: { spec: smartCommitFixture },
} satisfies Story;

export const Optimistic = {
  args: { spec: optimisticFixture },
} satisfies Story;

export const Retry = {
  args: { spec: retryFixture },
} satisfies Story;
