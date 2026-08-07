import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { GraphWorkflowAdvisoryIndexEntry } from "@/lib/workflow-graph/schemas";
import AdvisoryIndexPanel from "./AdvisoryIndexPanel";

const contextTitles = {
  "ctx-schema": "Schema and migrations",
  "ctx-engine": "Engine semantics",
  "ctx-ui": "Execution UI",
};

const index: GraphWorkflowAdvisoryIndexEntry[] = [
  {
    identity: { roundSeq: 1, assignmentId: "security", ordinal: 1 },
    kind: "plan",
    title: "The plan skips the migration backfill",
    contextId: "ctx-schema",
  },
  {
    identity: { roundSeq: 3, assignmentId: "general", ordinal: 2 },
    kind: "out_of_scope",
    title: "The legacy importer has been unreachable since the route rewrite",
    contextId: "ctx-schema",
  },
  {
    identity: { roundSeq: 1, assignmentId: "acceptance-criteria", ordinal: 1 },
    kind: "plan",
    title: "Two contexts both claim ownership of the retry budget",
    contextId: "ctx-engine",
  },
  {
    identity: { roundSeq: 2, assignmentId: "design", ordinal: 1 },
    kind: "out_of_scope",
    title: "The inspector and the builder disagree on the empty-cohort copy",
    contextId: "ctx-ui",
  },
];

const meta = {
  title: "SessionWorkflow/AdvisoryIndexPanel",
  component: AdvisoryIndexPanel,
  parameters: {
    layout: "padded",
    backgrounds: { default: "dark" },
  },
  args: {
    contextTitles,
    onOpenOrigin: fn(),
  },
} satisfies Meta<typeof AdvisoryIndexPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Long-lived advisories from three contexts and four rounds, in one list. */
export const AcrossContextsAndRounds: Story = {
  args: { index },
};

export const SingleEntry: Story = {
  args: { index: index.slice(0, 1) },
};

/** No host navigation: the origin reads as a label rather than a link. */
export const WithoutOriginNavigation: Story = {
  args: { index, onOpenOrigin: undefined },
};

/** A context the working definition no longer names falls back to its id. */
export const RetiredOriginContext: Story = {
  args: {
    index: [
      {
        identity: { roundSeq: 4, assignmentId: "security", ordinal: 1 },
        kind: "plan",
        title: "The removed context left its worktree branch behind",
        contextId: "ctx-removed",
      },
    ],
  },
};

/** The steady state for a run whose validators raised nothing long-lived. */
export const Empty: Story = {
  args: { index: [] },
};
