import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { Switch } from "@/components/ui/Switch";
import { ConfigTextInput } from "./ConfigControls";
import { ConfigControlRow, ConfigDrillRow, ConfigRowGroup } from "./ConfigRow";
import type { ConfigRowProvenance } from "./row-provenance";
import { chipPart, textPart, valuePart } from "./value-parts";

/**
 * The provenance chrome, at each of the three granularities an override is
 * stored and cleared at: a block, one validation role, one collaboration field.
 * Reset offers itself only on the rows the current tier actually set, and it
 * names the granularity it clears.
 */

function Rail({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex w-[420px] flex-col gap-[10px] bg-bg-surface p-lg font-mono">
      {children}
    </div>
  );
}

const inherited = (
  sourceTier: ConfigRowProvenance["sourceTier"],
  granularity: ConfigRowProvenance["granularity"],
): ConfigRowProvenance => ({ sourceTier, scopeTier: "context", granularity });

const setHere = (
  granularity: ConfigRowProvenance["granularity"],
): ConfigRowProvenance => ({
  sourceTier: "context",
  scopeTier: "context",
  granularity,
});

const meta = {
  title: "WorkflowConfigPanel/ConfigRow",
  component: ConfigControlRow,
  args: { rowId: "approval", label: "Human approval" },
} satisfies Meta<typeof ConfigControlRow>;

export default meta;
type Story = StoryObj<typeof meta>;

/** G and W tier chips, each with the sentence naming where the value came from. */
export const InheritedRows: Story = {
  render: () => (
    <Rail>
      <ConfigRowGroup label="Quality gates">
        <ConfigControlRow
          rowId="approval"
          label="Human approval"
          provenance={inherited("global", "block")}
          parts={[textPart("off", "dim")]}
        />
        <ConfigControlRow
          rowId="questions"
          label="Ask user questions"
          provenance={inherited("workflow", "block")}
          parts={[textPart("allowed", "green")]}
        />
        <ConfigControlRow
          rowId="agent-val-implementer"
          label="Implementer commands"
          provenance={inherited("global", "role")}
          parts={[valuePart("all")]}
        />
        <ConfigControlRow
          rowId="collab-rounds"
          label="Negotiation rounds"
          provenance={inherited("workflow", "field")}
          parts={[valuePart("2")]}
        />
      </ConfigRowGroup>
    </Rail>
  ),
};

/**
 * The cyan left edge marks a value the current tier owns; the reset button next
 * to it names exactly the granularity it clears, so a sibling role or field
 * keeps its own provenance.
 */
export const SetHereWithGranularReset: Story = {
  render: () => (
    <Rail>
      <ConfigRowGroup label="Set at this context">
        <ConfigControlRow
          rowId="breaker"
          label="Circuit breaker"
          hint="Reset this block to inherit"
          provenance={setHere("block")}
          parts={[valuePart("5"), textPart("failures", "dim")]}
          onReset={fn()}
        />
        <ConfigControlRow
          rowId="agent-val-validator"
          label="Validator commands"
          hint="Reset this role to inherit — the implementer role keeps its own"
          provenance={setHere("role")}
          parts={[valuePart("only 2")]}
          onReset={fn()}
        />
        <ConfigControlRow
          rowId="collab-threshold"
          label="Autonomous resolution"
          hint="Reset this field to inherit — the sibling fields keep theirs"
          provenance={setHere("field")}
          parts={[chipPart("minor")]}
          onReset={fn()}
        />
      </ConfigRowGroup>
    </Rail>
  ),
};

/** A locked surface keeps the provenance and withdraws the reset. */
export const LockedRows: Story = {
  render: () => (
    <Rail>
      <ConfigRowGroup label="Frozen context" tier="W">
        <ConfigControlRow
          rowId="breaker"
          label="Circuit breaker"
          provenance={setHere("block")}
          parts={[valuePart("5"), textPart("failures", "dim")]}
          onReset={fn()}
          disabled
        />
        <ConfigControlRow
          rowId="title"
          label="Title"
          provenance={inherited("workflow", "block")}
          control={
            <ConfigTextInput
              value="Implement checkout"
              onChange={fn()}
              ariaLabel="Title"
              disabled
            />
          }
          disabled
        />
      </ConfigRowGroup>
    </Rail>
  ),
};

/**
 * A drill row stands in for several paths at once: it reads as set here when
 * any of them is, while the tier chip still names where the block resolves from.
 */
export const DrillRows: Story = {
  render: () => (
    <Rail>
      <ConfigRowGroup label="Agents">
        <ConfigDrillRow
          screenId="implementer"
          label="implementer"
          parts={[chipPart("Claude Opus 5", "cyan")]}
          provenance={inherited("global", "block")}
          onOpen={fn()}
        />
        <ConfigDrillRow
          screenId="collaboration"
          label="collaboration"
          parts={[textPart("on", "green"), valuePart("2 rounds")]}
          provenance={{ ...inherited("workflow", "field"), setHere: true }}
          onOpen={fn()}
        />
      </ConfigRowGroup>
    </Rail>
  ),
};

/**
 * Reset in motion: the row owns the value, the reset drops it back, and the
 * inherited value with its tier chip takes over.
 */
export const ResetToInherit: Story = {
  render: function Render() {
    const [override, setOverride] = useState<boolean | null>(true);
    const inheritedValue = false;
    const value = override ?? inheritedValue;
    return (
      <Rail>
        <ConfigRowGroup label="Quality gates">
          <ConfigControlRow
            rowId="approval"
            label="Human approval"
            hint={
              override === null
                ? "Inherited from the workflow."
                : "Set on this context."
            }
            provenance={
              override === null
                ? inherited("workflow", "block")
                : setHere("block")
            }
            control={
              <Switch
                checked={value}
                onCheckedChange={(next) => setOverride(next)}
                aria-label="Human approval"
              />
            }
            onReset={() => setOverride(null)}
          />
        </ConfigRowGroup>
      </Rail>
    );
  },
};
