import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import SpecDeliveryScope from "./SpecDeliveryScope";
import { deliveryDashboardFixture } from "./SpecDeliveryScope.fixtures";

const fixture = deliveryDashboardFixture();
const meta = {
  title: "Specs/Studio/DeliveryScope",
  component: SpecDeliveryScope,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
  args: { ...fixture, projectName: "command-center" },
  decorators: [
    (Story) => (
      <div className="mx-auto h-screen max-w-[1200px] overflow-y-auto p-xl max-768:p-md">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SpecDeliveryScope>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const InspectRequirement: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: /Spec changes/ }));
    await userEvent.click(
      canvas.getByRole("button", { name: /R1 · requirement/ }),
    );
  },
};
export const InspectDecision: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: /Spec changes/ }));
    await userEvent.click(
      canvas.getByRole("button", { name: /Pin the complete execution scope/ }),
    );
    await expect(
      canvas.getByText(
        "A run must remain reproducible after authoring continues.",
      ),
    ).toBeVisible();
    await expect(
      canvas.getByRole("link", { name: "Open current Design" }),
    ).toHaveAttribute("href", expect.stringContaining("?el=D1"));
  },
};
export const NoDelivery: Story = {
  args: {
    projection: {
      ...fixture.projection,
      base: null,
      comparedExecution: null,
      criteria: fixture.projection.criteria.map((row) => ({
        ...row,
        class: "never_delivered",
      })),
      counts: {
        ...fixture.projection.counts,
        criteria: {
          delivered_and_fresh: 0,
          hard_stale: 0,
          soft_stale: 0,
          never_delivered: 12,
          deferred: 0,
          waived: 0,
        },
      },
    },
  },
};
export const Empty: Story = {
  args: {
    projection: {
      ...fixture.projection,
      elements: [],
      criteria: [],
      counts: {
        elements: { added: 0, amended: 0, removed: 0, unchanged: 0 },
        criteria: {
          delivered_and_fresh: 0,
          hard_stale: 0,
          soft_stale: 0,
          never_delivered: 0,
          deferred: 0,
          waived: 0,
        },
      },
    },
  },
};
