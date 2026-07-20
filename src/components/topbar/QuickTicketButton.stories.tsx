import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { Button } from "@/components/ui/Button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/DropdownMenu";
import QuickTicketButton from "./QuickTicketButton";

const meta = {
  title: "Components/Topbar/QuickTicketButton",
  component: QuickTicketButton,
  args: {
    pathname: "/projects/command-center",
  },
} satisfies Meta<typeof QuickTicketButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MobileMenuItem: Story = {
  render: (args) => (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost">Destinations</Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <QuickTicketButton {...args} presentation="menu-item" />
      </DropdownMenuContent>
    </DropdownMenu>
  ),
};
