import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  OwnedRunsRegion,
  OwnerRunCard,
  SessionRunsCard,
} from "@/components/runs/RunCards";
import {
  checkoutRun,
  noticeRunAwaitingApproval,
  sessionRuns,
} from "./fixtures";
import type { RunSummary } from "@/components/runs/model";

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
 * from the person comes with its action. A catalog of card states: the
 * conversation itself shows only its runs that have not finished.
 */
export const InTheOwnerConversation: Story = {
  render: () => (
    <div className="flex min-h-[100dvh] justify-center bg-bg-void px-xl py-2xl">
      <div className="flex w-full max-w-[760px] flex-col gap-md">
        <OwnerRunCard
          run={checkout}
          attention={checkoutRun.attention}
          hrefOf={() => "#"}
          onControl={fn()}
        />
        <OwnerRunCard
          run={{
            ...notice,
            status: { kind: "needs_input" },
            attention: 1,
            costUsd: 2.18,
          }}
          attention={noticeRunAwaitingApproval.attention}
          hrefOf={() => "#"}
          onControl={fn()}
        />
        <OwnerRunCard
          run={notice}
          attention={[]}
          hrefOf={() => "#"}
          onControl={fn()}
        />
        <OwnerRunCard
          run={docsIndex}
          attention={[]}
          hrefOf={() => "#"}
          onControl={fn()}
        />
        <OwnerRunCard
          run={spike}
          attention={[]}
          hrefOf={() => "#"}
          onControl={fn()}
        />
      </div>
    </div>
  ),
};

/**
 * The cards in a laptop-height conversation (1280×720): the region is bounded
 * and scrolls, and each card keeps its height, so every action stays reachable.
 */
export const AboveAShortComposer: Story = {
  render: () => (
    <div className="flex h-[720px] flex-col bg-bg-void">
      <div className="min-h-0 flex-1 p-lg font-mono text-[0.78rem] text-text-tertiary">
        The transcript
      </div>
      <OwnedRunsRegion>
        <OwnerRunCard
          run={checkout}
          attention={checkoutRun.attention}
          hrefOf={() => "#"}
          onControl={fn()}
        />
        <OwnerRunCard
          run={{ ...notice, status: { kind: "needs_input" }, attention: 1 }}
          attention={noticeRunAwaitingApproval.attention}
          hrefOf={() => "#"}
          onControl={fn()}
        />
        <OwnerRunCard
          run={{ ...docsIndex, finishedAt: null, status: { kind: "running" } }}
          attention={[]}
          hrefOf={() => "#"}
          onControl={fn()}
        />
      </OwnedRunsRegion>
      <div className="h-[150px] shrink-0 border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-base p-lg font-mono text-[0.78rem] text-text-tertiary">
        The composer
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
          hrefOf={() => "#"}
          onBrowseTemplates={fn()}
        />
      </div>
      <div className="w-full max-w-[360px]">
        <SessionRunsCard
          runs={[]}
          hrefOf={() => "#"}
          onBrowseTemplates={fn()}
        />
      </div>
    </div>
  ),
};
