import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import CollapsibleText from "./CollapsibleText";

const meta = {
  title: "Components/CollapsibleText",
  component: CollapsibleText,
  parameters: {
    layout: "centered",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 320, background: "var(--bg-surface)", padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollapsibleText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Short: Story = {
  args: {
    maxCollapsedHeight: 120,
    children: (
      <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
        This text is short enough that it does not need collapsing. No toggle
        should be shown.
      </p>
    ),
  },
};

export const Long: Story = {
  args: {
    maxCollapsedHeight: 120,
    children: (
      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
        <p>
          Implement REST API endpoints for user management with authentication
          and validation. All endpoints must use Zod schema validation.
        </p>
        <p>
          JWT tokens should be used for auth middleware. Rate limiting must be
          applied on public endpoints. The existing /api/health endpoint pattern
          should be followed for consistency.
        </p>
        <p>
          Additional requirements include proper error handling with descriptive
          messages, request logging, and response caching where appropriate.
        </p>
        <p>
          The implementation should follow the project&apos;s established
          patterns for API route organization under src/app/api/.
        </p>
        <p>
          Tests must be written for all endpoints including edge cases such as
          invalid input, duplicate entries, and authentication failures.
        </p>
      </div>
    ),
  },
};

export const CustomHeight: Story = {
  args: {
    maxCollapsedHeight: 60,
    children: (
      <div style={{ fontSize: "0.75rem", color: "var(--text-secondary)" }}>
        <p>
          Even a moderate amount of text will be collapsed when the max height
          is set to a small value like 60px.
        </p>
        <p>
          This second paragraph will be hidden behind the fade gradient until
          the user clicks &quot;Show more&quot;.
        </p>
      </div>
    ),
  },
};
