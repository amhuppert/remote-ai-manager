import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { ParameterDeclaration } from "@/lib/workflows/schemas";
import WorkflowLaunchForm from "./WorkflowLaunchForm";

const mixedParameters: ParameterDeclaration[] = [
  {
    type: "string",
    name: "feature",
    label: "Feature name",
    required: true,
    default: "checkout-revamp",
  },
  {
    type: "text",
    name: "brief",
    label: "Brief",
    required: true,
    default: "Redesign the checkout flow to reduce drop-off.",
  },
  {
    type: "enum",
    name: "mode",
    label: "Creation mode",
    required: true,
    options: ["fast", "focus", "thorough"],
    default: "focus",
  },
];

const meta = {
  title: "Workflows/WorkflowLaunchForm",
  component: WorkflowLaunchForm,
  args: {
    parameters: mixedParameters,
    onLaunch: fn(),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 460,
          padding: 16,
          background: "var(--bg-base)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof WorkflowLaunchForm>;

export default meta;
type Story = StoryObj<typeof meta>;

// Zero-input definition: no parameter inputs, immediate launch (R7.6).
export const ZeroInput = {
  args: {
    parameters: [],
  },
} satisfies Story;

// Mixed parameter types, each pre-populated with its declared default (R7.3).
export const MixedTypesWithDefaults = {
  args: {
    parameters: mixedParameters,
  },
} satisfies Story;

// A required parameter with no default and no value — launch is blocked until
// the missing-required condition is resolved (R7.4).
export const RequiredEmpty = {
  args: {
    parameters: [
      {
        type: "string",
        name: "feature",
        label: "Feature name",
        required: true,
      },
      { type: "text", name: "brief", label: "Brief", required: true },
    ],
  },
} satisfies Story;

// An enum parameter constrained to its declared options (R7.2).
export const EnumSelect = {
  args: {
    parameters: [
      {
        type: "enum",
        name: "mode",
        label: "Creation mode",
        required: true,
        options: ["fast", "focus", "thorough"],
        default: "fast",
      },
    ],
  },
} satisfies Story;

// The engine rejected the launch at start time; the reason is surfaced (R7.7).
export const EngineError = {
  args: {
    parameters: mixedParameters,
    engineError:
      "Worktree has uncommitted changes. Commit or stash them before launching.",
  },
} satisfies Story;

// A launch is in flight; the launch control is disabled (R7.7).
export const Launching = {
  args: {
    parameters: mixedParameters,
    isLaunching: true,
  },
} satisfies Story;
