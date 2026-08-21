import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import type { ValidationBudgetResponse } from "@/lib/validation/api-schemas";
import { buildValidationBudgetView } from "@/lib/validation/budget-view";

import { ValidationBudgetPanel } from "./ValidationBudgetPanel";

function view(response: ValidationBudgetResponse) {
  const built = buildValidationBudgetView(response);
  if (built === null) throw new Error("expected a renderable budget view");
  return built;
}

function running(
  runId: string,
  commandName: string,
  cost: number,
  projectName: string,
  sessionName: string | null = "csm/validation-budget",
  conversationId: string | null = `conv-${runId}`,
) {
  return {
    runId,
    commandName,
    status: "running" as const,
    cost,
    projectName,
    sessionName,
    conversationId,
    position: null,
  };
}

function queued(index: number, commandName: string, cost: number) {
  return {
    runId: `q-${index}`,
    commandName,
    status: "queued" as const,
    cost,
    projectName: index % 2 === 0 ? "taskgarden" : "command-center",
    sessionName: "csm/spec-import",
    conversationId: `queued-conv-${index}`,
    position: index,
  };
}

const meta = {
  title: "Components/Topbar/ValidationBudgetPanel",
  component: ValidationBudgetPanel,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <div className="w-[400px] overflow-hidden rounded-md border border-solid border-border-default bg-bg-elevated">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ValidationBudgetPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The committed direction: limit 8, three running commands holding 4 + 2 + 1,
 * nine queued. One unit is free and unusable — the queue head costs four and
 * FIFO never skips it.
 */
export const QueueBlocked: Story = {
  args: {
    view: view({
      available: true,
      capacity: { limit: 8, inUse: 7, queueDepth: 9 },
      runs: [
        running("r-test", "test", 4, "command-center"),
        running("r-lint", "lint", 2, "taskgarden", "csm/spec-import"),
        running("r-format", "format", 1, "command-center"),
        ...Array.from({ length: 9 }, (_, index) =>
          queued(
            index,
            index === 1 ? "typecheck" : "test",
            index === 1 ? 2 : 4,
          ),
        ),
      ],
    }),
  },
};

/** Running freely with headroom — cyan ring, no queue section. */
export const RunningWithHeadroom: Story = {
  args: {
    view: view({
      available: true,
      capacity: { limit: 8, inUse: 3, queueDepth: 0 },
      runs: [
        running("r-typecheck", "typecheck", 2, "command-center"),
        running("r-format", "format", 1, "taskgarden", "csm/spec-import"),
      ],
    }),
  },
};

/** Every unit held by one large run, with work stacked behind it. */
export const AtCapacity: Story = {
  args: {
    view: view({
      available: true,
      capacity: { limit: 8, inUse: 8, queueDepth: 3 },
      runs: [
        running("r-test", "test", 8, "command-center"),
        ...Array.from({ length: 3 }, (_, index) =>
          queued(index, "typecheck", 2),
        ),
      ],
    }),
  },
};

/**
 * A system-owned gate (lane merge, Smart Merge, Smart Commit) names no
 * conversation or session, so its row degrades to the project.
 */
export const SystemOwnedRun: Story = {
  args: {
    view: view({
      available: true,
      capacity: { limit: 8, inUse: 6, queueDepth: 0 },
      runs: [
        running("r-merge", "test", 4, "command-center", null, null),
        running("r-lint", "lint", 2, "taskgarden", "csm/spec-import"),
      ],
    }),
  },
};
