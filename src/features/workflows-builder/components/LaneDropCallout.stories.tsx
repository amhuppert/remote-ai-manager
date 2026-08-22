import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import LaneDropCallout from "./LaneDropCallout";

/**
 * B2's verdict cards. Concurrency is explained where it bites (README §4): a
 * placement that is legal and still costs the author something says so at the
 * moment it is made, and a refusal names the overlap it refused over.
 */
const meta = {
  title: "WorkflowsBuilder/LaneDropCallout",
  component: LaneDropCallout,
  parameters: { layout: "centered", backgrounds: { default: "dark" } },
  args: { onDismiss: fn() },
  decorators: [
    (Story) => (
      <div
        style={{
          position: "relative",
          width: 420,
          height: 220,
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LaneDropCallout>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The reserved session lane refusing a write-capable context. */
export const RefusedReservedLane: Story = {
  args: {
    tone: "red",
    title: "Placement check failed",
    message:
      '"session" admits only read-only contexts. "Implement checkout" is owning (src/checkout, src/risk). Change its grade to read-only, or drop it on a group lane.',
    footnote:
      "Nothing was written. The definition is still at the same dirty state it had before the drag.",
  },
};

/** Two unordered owning members claiming the same path — the overlap is named. */
export const RefusedOwnedPathOverlap: Story = {
  args: {
    tone: "red",
    title: "Placement check failed",
    message:
      'Contexts "Implement checkout" and "Settings surface" share lane delivery with overlapping owned paths (src/checkout) and no dependency ordering them. Give the two members disjoint owned paths, or add a dependency edge so one runs after the other.',
    footnote:
      "Nothing was written. The definition is still at the same dirty state it had before the drag.",
  },
};

/**
 * Accepted, and still worth saying: a full-grade member needs the lane to
 * itself, so it waits while the lane's other write-capable members run.
 */
export const AcceptedWithOccupancyNotice: Story = {
  args: {
    tone: "amber",
    title: "Placement accepted",
    message:
      '"Rollout switch" needs exclusive occupancy of lane delivery, so it waits while the lane\'s other write-capable members run.',
    footnote:
      "The placement was written. Only placement.lane changed — the grade and its owned paths carried across.",
  },
};

/** Naming an empty band after a lane that already exists (README §2.2). */
export const EphemeralLaneMerged: Story = {
  args: {
    tone: "amber",
    title: "Lane already exists",
    message:
      'Naming it delivery means "use the existing lane" — the band merges with it rather than creating a duplicate.',
    footnote:
      "Nothing was written: an empty lane is draft UI, so there was no duplicate to remove from the definition.",
  },
};
