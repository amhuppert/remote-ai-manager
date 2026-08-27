import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import type { BackendModelSelection } from "@/lib/agent-backends/schemas";

import {
  DesktopModelSelectionControls,
  type DesktopModelSelectionControlsProps,
} from "./ModelSelectionControls";
import {
  effortOnlyModelCatalog,
  fullModelParameterCatalog,
} from "./model-selection-story-data";

function ControlsHarness({
  catalog,
  selection: initialSelection,
  ...props
}: DesktopModelSelectionControlsProps): React.JSX.Element {
  const [selection, setSelection] =
    useState<BackendModelSelection>(initialSelection);
  return (
    <div className="rounded-lg border border-border-subtle bg-bg-base p-lg">
      <DesktopModelSelectionControls
        {...props}
        catalog={catalog}
        selection={selection}
        onSelectionChange={setSelection}
      />
    </div>
  );
}

const meta = {
  title: "Session/Prompt/ModelSelectionControls",
  component: DesktopModelSelectionControls,
  args: {
    catalog: fullModelParameterCatalog,
    selection: fullModelParameterCatalog.models[0]!.variants[0]!.selection,
    onSelectionChange: () => {},
  },
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof DesktopModelSelectionControls>;

export default meta;
type Story = StoryObj<typeof meta>;

export const FullCursorParameters: Story = {
  render: () => (
    <ControlsHarness
      catalog={fullModelParameterCatalog}
      selection={fullModelParameterCatalog.models[0]!.variants[0]!.selection}
      onSelectionChange={() => {}}
    />
  ),
};

export const ConstrainedOptionsOpen: Story = {
  render: () => (
    <ControlsHarness
      catalog={fullModelParameterCatalog}
      selection={fullModelParameterCatalog.models[0]!.variants[0]!.selection}
      onSelectionChange={() => {}}
      optionsDefaultOpen
    />
  ),
};

export const EffortOnly: Story = {
  render: () => (
    <ControlsHarness
      catalog={effortOnlyModelCatalog}
      selection={effortOnlyModelCatalog.models[0]!.variants[1]!.selection}
      onSelectionChange={() => {}}
    />
  ),
};

export const NoParameters: Story = {
  render: () => (
    <ControlsHarness
      catalog={effortOnlyModelCatalog}
      selection={effortOnlyModelCatalog.models[1]!.variants[0]!.selection}
      onSelectionChange={() => {}}
    />
  ),
};

/**
 * The catalog marks this model's `xhigh` reasoning tier as exceeding the
 * provider's scale, so the primary control takes the rainbow treatment.
 */
export const ExceedsScaleTier: Story = {
  render: () => (
    <ControlsHarness
      catalog={fullModelParameterCatalog}
      selection={fullModelParameterCatalog.models[0]!.variants[3]!.selection}
      onSelectionChange={() => {}}
    />
  ),
};

export const StaleSelection: Story = {
  render: () => (
    <ControlsHarness
      catalog={fullModelParameterCatalog}
      selection={{
        modelId: "removed-model",
        parameters: { reasoning: "obsolete" },
      }}
      onSelectionChange={() => {}}
    />
  ),
};

export const Disabled: Story = {
  render: () => (
    <ControlsHarness
      catalog={fullModelParameterCatalog}
      selection={fullModelParameterCatalog.models[0]!.variants[0]!.selection}
      onSelectionChange={() => {}}
      disabled
    />
  ),
};
