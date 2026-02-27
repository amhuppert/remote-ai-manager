import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import PresetInstallDialog from "./PresetInstallDialog";

const meta = {
  title: "Projects/PresetInstallDialog",
  component: PresetInstallDialog,
  args: {
    open: true,
    projectName: "my-app",
    onInstall: fn(),
    onClose: fn(),
    isInstalling: false,
    installedPresets: [],
  },
} satisfies Meta<typeof PresetInstallDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const WithInstalledPreset = {
  args: {
    installedPresets: ["nextjs"],
  },
} satisfies Story;

export const AllInstalled = {
  args: {
    installedPresets: ["nextjs", "storybook"],
  },
} satisfies Story;

export const Installing = {
  args: {
    isInstalling: true,
  },
} satisfies Story;

export const Closed = {
  args: {
    open: false,
  },
} satisfies Story;
