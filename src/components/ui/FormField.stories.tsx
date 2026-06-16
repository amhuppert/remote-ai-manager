import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  FormGroup,
  FormLabel,
  FormInput,
  FormHint,
  FormError,
} from "./FormField";

const meta = {
  title: "UI/FormField",
  component: FormInput,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof FormInput>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Label + input + hint — the canonical field composition. */
export const WithHint: Story = {
  render: () => (
    <div style={{ width: 320 }}>
      <FormGroup>
        <FormLabel htmlFor="session-name">Session name</FormLabel>
        <FormInput
          id="session-name"
          placeholder="feature-x"
          defaultValue="migrate-to-tailwind"
        />
        <FormHint>Used as the git branch suffix.</FormHint>
      </FormGroup>
    </div>
  ),
};

/** Error state — `FormError` replaces the hint. */
export const WithError: Story = {
  render: () => (
    <div style={{ width: 320 }}>
      <FormGroup>
        <FormLabel htmlFor="repo-path">Repository path</FormLabel>
        <FormInput id="repo-path" defaultValue="/not/a/repo" />
        <FormError>That path is not a git repository.</FormError>
      </FormGroup>
    </div>
  ),
};

export const Placeholder: Story = {
  render: () => (
    <div style={{ width: 320 }}>
      <FormGroup>
        <FormLabel htmlFor="search">Search</FormLabel>
        <FormInput id="search" placeholder="Type to filter…" />
      </FormGroup>
    </div>
  ),
};
