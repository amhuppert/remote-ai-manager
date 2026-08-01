import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useState } from "react";
import { fn } from "storybook/test";
import { OUTPUT_SCHEMA_TEMPLATE, OutputSchemaField } from "./OutputSchemaField";

const BROKEN_JSON = `{
  "type": "object",
  "properties": {
    "verdict": { "type": "string", "enum": ["pass", "fail", "blocked"] }
    "confidence": { "type": "number" }
  },
  "required": ["verdict"]
}`;

const UNSUPPORTED = `{
  "type": "object",
  "properties": {
    "owner": { "$ref": "#/$defs/person" },
    "risk": { "anyOf": [{ "type": "string" }, { "type": "null" }] },
    "dueDate": { "type": "string", "format": "date" }
  },
  "required": ["owner"]
}`;

// The inspector body the field lives in: 500px panel, surface background.
function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ width: 468, padding: 16, background: "var(--bg-surface)" }}
      className="flex flex-col gap-lg"
    >
      {children}
    </div>
  );
}

// The field is a controlled text editor, so a story needs local state to be
// interactive — the lint then runs for real against whatever is typed.
function Harness({
  seed,
  readOnly,
  readOnlyHint,
}: {
  seed: string;
  readOnly?: boolean;
  readOnlyHint?: string;
}) {
  const [value, setValue] = useState(seed);
  return (
    <Panel>
      <OutputSchemaField
        value={value}
        onChange={setValue}
        readOnly={readOnly}
        readOnlyHint={readOnlyHint}
      />
    </Panel>
  );
}

const meta = {
  title: "WorkflowConfig/OutputSchemaField",
  component: OutputSchemaField,
  args: { value: OUTPUT_SCHEMA_TEMPLATE, onChange: fn() },
} satisfies Meta<typeof OutputSchemaField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => <Harness seed="" />,
};

export const Valid: Story = {
  render: () => <Harness seed={OUTPUT_SCHEMA_TEMPLATE} />,
};

export const InvalidJson: Story = {
  render: () => <Harness seed={BROKEN_JSON} />,
};

export const UnsupportedKeywords: Story = {
  render: () => <Harness seed={UNSUPPORTED} />,
};

export const ReadOnlyFrozen: Story = {
  render: () => (
    <Harness
      seed={OUTPUT_SCHEMA_TEMPLATE}
      readOnly
      readOnlyHint="The output was already captured against this schema — editing it now would not re-validate anything."
    />
  ),
};

// The undo notice is reachable only by clearing, so this story starts from a
// set schema and the Clear affordance drives it.
export const ClearToUndo: Story = {
  render: () => <Harness seed={OUTPUT_SCHEMA_TEMPLATE} />,
};
