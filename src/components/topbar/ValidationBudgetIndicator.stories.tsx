import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { ValidationBudgetResponse } from "@/lib/validation/api-schemas";
import { validationKeys } from "@/lib/validation/query-keys";

import {
  ValidationBudgetIndicator,
  ValidationBudgetSheet,
} from "./ValidationBudgetIndicator";

/**
 * The indicator reads its own query, so each story seeds the shared client's
 * budget key before rendering — the same path production takes, minus the
 * network.
 */
function SeedBudget({
  response,
  children,
}: {
  response: ValidationBudgetResponse;
  children: React.ReactNode;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  useState(() => {
    queryClient.setQueryData(validationKeys.budget(), response);
    return null;
  });
  return <>{children}</>;
}

/** A stand-in for the topbar's right-hand control cluster. */
function TopbarStrip({
  response,
}: {
  response: ValidationBudgetResponse;
}): React.JSX.Element {
  return (
    <SeedBudget response={response}>
      <header className="flex h-[var(--topbar-height)] items-center justify-between border-x-0 border-t-0 border-b border-solid border-b-border-subtle bg-[var(--cc-topbar-bg)] px-lg">
        <span className="font-display text-[1.1rem] font-extrabold tracking-[-0.02em] text-cyan [text-shadow:0_0_20px_var(--cyan-glow-text)]">
          CC
        </span>
        <div className="flex items-center gap-md">
          <div className="flex items-center gap-[6px] font-mono text-[0.72rem] font-medium tracking-[0.06em] text-text-secondary uppercase">
            3 sessions running
          </div>
          <div className="h-[20px] w-px bg-border-default" />
          <ValidationBudgetIndicator />
        </div>
      </header>
    </SeedBudget>
  );
}

/** The bottom sheet on its own, already open. */
function SheetHarness({
  response,
}: {
  response: ValidationBudgetResponse;
}): React.JSX.Element {
  return (
    <SeedBudget response={response}>
      <ValidationBudgetSheet open onOpenChange={() => {}} />
    </SeedBudget>
  );
}

const QUEUE_BLOCKED: ValidationBudgetResponse = {
  available: true,
  capacity: { limit: 8, inUse: 7, queueDepth: 9 },
  runs: [
    {
      runId: "r-test",
      commandName: "test",
      status: "running",
      cost: 4,
      projectName: "command-center",
      sessionName: "csm/validation-budget",
      conversationId: "conv-1",
      position: null,
    },
    {
      runId: "r-lint",
      commandName: "lint",
      status: "running",
      cost: 2,
      projectName: "taskgarden",
      sessionName: "csm/spec-import",
      conversationId: "conv-2",
      position: null,
    },
    {
      runId: "r-format",
      commandName: "format",
      status: "running",
      cost: 1,
      projectName: "command-center",
      sessionName: "csm/merge-hardening",
      conversationId: "conv-3",
      position: null,
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      runId: `q-${index}`,
      commandName: index === 1 ? "typecheck" : "test",
      status: "queued" as const,
      cost: index === 1 ? 2 : 4,
      projectName: index === 1 ? "command-center" : "taskgarden",
      sessionName: "csm/spec-import",
      conversationId: `queued-conv-${index}`,
      position: index,
    })),
  ],
};

const meta = {
  title: "Components/Topbar/ValidationBudgetIndicator",
  component: TopbarStrip,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
} satisfies Meta<typeof TopbarStrip>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Seven of eight units held, nine queued — the committed direction. */
export const InTopbar: Story = {
  args: { response: QUEUE_BLOCKED },
};

/** Below 768px the count drops and only the ring survives the bar. */
export const Mobile: Story = {
  args: { response: QUEUE_BLOCKED },
  globals: { viewport: { value: "mobile1", isRotated: false } },
};

/** Nothing running and nothing queued — the indicator renders nothing at all. */
export const IdleBudgetIsHidden: Story = {
  args: {
    response: {
      available: true,
      capacity: { limit: 8, inUse: 0, queueDepth: 0 },
      runs: [],
    },
  },
};

/**
 * The mobile detail: the same panel docked as a bottom sheet, opened from the
 * topbar's overflow menu. Review at 390×844.
 */
export const MobileSheet: StoryObj<typeof SheetHarness> = {
  render: () => <SheetHarness response={QUEUE_BLOCKED} />,
  globals: { viewport: { value: "mobile1", isRotated: false } },
};
