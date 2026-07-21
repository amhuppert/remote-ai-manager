import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  NeedsYouMenu,
  type NeedsYouItem,
} from "@/components/topbar/NeedsYouMenu";

const nowMs = Date.parse("2026-07-17T16:00:00.000Z");

const mixedItems: NeedsYouItem[] = [
  {
    id: "spec-signoff",
    source: "active-work",
    kind: "spec",
    label: "Sign-off blocked",
    title: "native-sdd rev 4",
    detail:
      "Precondition unmet: blocking thread on R6 unresolved · A2 rejected, cited by D4",
    occurredAt: "2026-07-17T15:58:00.000Z",
    href: "/specs/command-center/native-sdd?el=R6",
  },
  {
    id: "spec-waiver",
    source: "active-work",
    kind: "spec",
    label: "Waiver requested",
    title: "native-sdd/R3.2",
    detail: "EX-7 agent requests a waiver — agents route, only you can grant",
    occurredAt: "2026-07-17T15:54:00.000Z",
    href: "/specs/command-center/native-sdd?el=R3.2",
  },
  {
    id: "conversation-question",
    source: "active-work",
    kind: "spec",
    label: "Assumption disposition",
    title: "native-sdd/A3",
    detail: "Proposed by the drafting agent — confirm / reject / defer",
    occurredAt: "2026-07-17T15:42:00.000Z",
    href: "/projects/command-center?focus=conversation-sdd",
  },
  {
    id: "definition-review",
    source: "active-work",
    kind: "spec",
    label: "Definition approval",
    title: "cli-foundation EX-8",
    detail:
      "Workflow definition generated from rev 3 — awaiting approval before start",
    occurredAt: "2026-07-17T15:19:00.000Z",
    href: "/specs/command-center/cli-foundation",
  },
];

const meta = {
  title: "Components/Topbar/NeedsYouMenu",
  component: NeedsYouMenu,
  parameters: {
    a11y: { test: "error" },
    layout: "fullscreen",
  },
  decorators: [
    (Story) => (
      <main className="flex min-h-[320px] justify-end bg-bg-void p-lg">
        <h1 className="sr-only">Needs you menu</h1>
        <Story />
      </main>
    ),
  ],
  args: {
    items: mixedItems,
    nowMs,
  },
} satisfies Meta<typeof NeedsYouMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {} satisfies Story;

export const Open = {
  args: { defaultOpen: true },
} satisfies Story;

export const AssumptionOnly = {
  args: {
    defaultOpen: true,
    items: [mixedItems[2]!],
  },
} satisfies Story;

export const Mobile = {
  args: { defaultOpen: true },
  parameters: {
    viewport: { width: 390, height: 844 },
  },
} satisfies Story;
