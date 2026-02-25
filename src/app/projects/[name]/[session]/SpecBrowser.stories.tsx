import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import SpecBrowser from "./SpecBrowser";

const meta = {
  title: "Session/SpecBrowser",
  component: SpecBrowser,
  decorators: [
    (Story) => (
      <div
        style={{
          height: 500,
          display: "flex",
          flexDirection: "column",
          background: "var(--bg-void)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SpecBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Default story — renders the SpecBrowser pointed at a project.
 * In Storybook without a running API, this will show the loading/error state.
 * To see the full interactive component, run with the dev server active.
 */
export const Default: Story = {
  args: {
    projectName: "remote-ai-manager",
    sessionName: "example-session",
  },
};

export const MobileWidth: Story = {
  args: {
    projectName: "remote-ai-manager",
    sessionName: "example-session",
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};
