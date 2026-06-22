import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { ParameterDeclaration } from "@/lib/workflows/schemas";
import ParameterDeclarationEditor from "./ParameterDeclarationEditor";

const mixedParameters: ParameterDeclaration[] = [
  {
    type: "string",
    name: "featureName",
    label: "Feature name",
    required: true,
    default: "checkout-flow",
    minLength: 1,
    maxLength: 64,
  },
  {
    type: "text",
    name: "brief",
    label: "Feature brief",
    required: false,
  },
  {
    type: "enum",
    name: "reviewMode",
    label: "Review mode",
    required: true,
    options: ["lenient", "strict"],
    default: "strict",
  },
];

const duplicateParameters: ParameterDeclaration[] = [
  { type: "string", name: "feature", label: "Feature", required: true },
  { type: "text", name: "feature", label: "Feature (again)", required: false },
];

const meta = {
  title: "Workflows/ParameterDeclarationEditor",
  component: ParameterDeclarationEditor,
  args: {
    parameters: [],
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 420,
          padding: 16,
          background: "var(--bg-base)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ParameterDeclarationEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty = {
  args: {
    parameters: [],
  },
} satisfies Story;

export const MixedTypes = {
  args: {
    parameters: mixedParameters,
  },
} satisfies Story;

export const DuplicateName = {
  args: {
    parameters: duplicateParameters,
  },
} satisfies Story;

export const SaveError = {
  args: {
    parameters: mixedParameters,
    saveError:
      "Field tasks[0].instructions references undeclared parameter {{inputs.missingName}}",
  },
} satisfies Story;
