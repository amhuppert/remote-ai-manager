import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CollabReaderOverlay from "@/features/session/conversation/collab/CollabReaderOverlay";

const SampleCard = ({
  agent,
  title,
  children,
}: {
  agent: "claude" | "codex";
  title: string;
  children: React.ReactNode;
}) => (
  <section
    className="mb-md flex min-w-0 flex-col overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-raised"
    style={{
      borderLeftWidth: 3,
      borderLeftColor: agent === "claude" ? "var(--cyan)" : "var(--violet)",
    }}
  >
    <div className="flex items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle px-md py-sm font-mono text-[0.78rem] font-semibold tracking-[0.04em] text-text-primary uppercase">
      {title}
    </div>
    <div className="flex flex-col gap-sm p-md font-mono text-[0.82rem] leading-[1.55] text-text-secondary">
      {children}
    </div>
  </section>
);

const SampleContent = () => (
  <>
    <SampleCard agent="claude" title="Agent One · Draft">
      <p className="m-0">
        A narrow conversation_compactions table risks baking storage details
        into the product surface. The requested feature spans message, segment,
        conversation, future decision refs, and cross-conversation artifacts.
      </p>
      <p className="m-0">
        Proposed a normalized schema with a compaction ledger keyed by segment,
        so replays reconstruct state without denormalizing into the hot path.
      </p>
    </SampleCard>
    <SampleCard agent="codex" title="Agent Two · Cross-review">
      <p className="m-0">
        Agrees the ledger keeps the write path clean, but disagrees on keying by
        segment — a compaction can span segments after a fork merges, so the key
        should be the decision ref instead.
      </p>
    </SampleCard>
    <SampleCard agent="claude" title="Agent One · Round 2">
      <p className="m-0">
        Accepts decision-ref keying. Remaining disagreement: whether to retain
        pre-compaction snapshots or reconstruct lazily. Trajectory: 3 → 1 open
        disagreements.
      </p>
    </SampleCard>
  </>
);

const meta = {
  title: "Collab/CollabReaderOverlay",
  component: CollabReaderOverlay,
  args: {
    currentIndex: 2,
    total: 7,
    onPrev: fn(),
    onNext: fn(),
    onOpenControls: fn(),
    onClose: fn(),
    children: <SampleContent />,
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CollabReaderOverlay>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveRound = {
  args: {
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "negotiation", round: 2 }, status: "active" },
      { kind: { kind: "final_answer" }, status: "pending" },
    ],
  },
} satisfies Story;

export const Converged = {
  args: {
    currentIndex: 6,
    phases: [
      { kind: { kind: "initial_draft" }, status: "done" },
      { kind: { kind: "cross_review" }, status: "done" },
      { kind: { kind: "negotiation", round: 1 }, status: "done" },
      { kind: { kind: "negotiation", round: 2 }, status: "done" },
      { kind: { kind: "final_answer" }, status: "done" },
    ],
    verdict: "converged",
  },
} satisfies Story;
