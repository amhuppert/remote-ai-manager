import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { TemplateLibrary } from "./components/template/TemplateLibrary";
import { templateList } from "./template-fixtures";

const meta = {
  title: "Runs/Template library",
  component: TemplateLibrary,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-[100dvh] bg-bg-void">
        <Story />
      </div>
    ),
  ],
  args: { templates: templateList, onConfigure: fn(), onLaunch: fn() },
} satisfies Meta<typeof TemplateLibrary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SavedTemplates: Story = {};
export const Empty: Story = { args: { templates: [] } };
export const Unreadable: Story = {
  args: {
    diagnostics: [
      {
        tier: "project",
        id: "release-train",
        path: "/Users/alex/Library/Application Support/cc/run-templates/L1VzZXJzL2FsZXgvcmVwbw/release-train.json",
        reason: "Unexpected token } in JSON at position 412",
      },
    ],
  },
};
export const LongNames: Story = {
  args: {
    templates: templateList.map((template, index) =>
      index === 0
        ? {
            ...template,
            name: "Release readiness review across frontend, API and data migration lanes",
          }
        : template,
    ),
  },
};
