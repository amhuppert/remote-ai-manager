import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { OwnerRunCard, SessionRunsCard } from "./components/RunCards";
import {
  checkoutRun,
  noticeRunAwaitingApproval,
  sessionRuns,
} from "./fixtures";
import type { RunSummary } from "./model";

const [checkout, notice, docsIndex, spike] = sessionRuns as [
  RunSummary,
  RunSummary,
  RunSummary,
  RunSummary,
];

/** Where a run appears outside its page: in the owner conversation, and on the session overview. */
const meta = {
  title: "Runs/Entry points",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The runs a conversation owns, as cards above its composer: what each needs
 * from the person comes with its action.
 */
export const InTheOwnerConversation: Story = {
  render: () => (
    <div className="flex min-h-[100dvh] justify-center bg-bg-void px-xl py-2xl">
      <div className="flex w-full max-w-[760px] flex-col gap-md">
        <OwnerRunCard
          run={checkout}
          attention={checkoutRun.attention}
          onOpen={fn()}
          onAct={fn()}
        />
        <OwnerRunCard
          run={{
            ...notice,
            status: { kind: "needs_input" },
            attention: 1,
            costUsd: 2.18,
          }}
          attention={noticeRunAwaitingApproval.attention}
          onOpen={fn()}
          onAct={fn()}
        />
        <OwnerRunCard run={notice} attention={[]} onOpen={fn()} onAct={fn()} />
        <OwnerRunCard
          run={docsIndex}
          attention={[]}
          onOpen={fn()}
          onAct={fn()}
        />
        <OwnerRunCard run={spike} attention={[]} onOpen={fn()} onAct={fn()} />
      </div>
    </div>
  ),
};

/** The session overview's runs card, in the right column where the workflow card sat. */
export const OnTheSessionOverview: Story = {
  render: () => (
    <div className="flex min-h-[100dvh] flex-wrap content-start items-start gap-xl bg-bg-void px-xl py-2xl">
      <div className="w-full max-w-[360px]">
        <SessionRunsCard
          runs={sessionRuns}
          onOpen={fn()}
          onBrowseTemplates={fn()}
        />
      </div>
      <div className="w-full max-w-[360px]">
        <SessionRunsCard runs={[]} onOpen={fn()} onBrowseTemplates={fn()} />
      </div>
    </div>
  ),
};
