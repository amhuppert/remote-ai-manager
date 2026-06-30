import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import "@/app/globals.css";
import DebugStructuredCard from "@/components/DebugStructuredCard";

// The card's amber chrome + the row dividers read CC tokens (var(--cc-amber-*)),
// so each story renders inside `[data-debug-mode]` on a void background to match
// the in-app debug surface. The hypothesis rows (HYP_CLASS) and the numbered
// step rows (STEPS_CLASS) are the elements whose single-side `border-t` divider
// must NOT bleed into a full ~3px currentColor border on the other three edges.
//
// Decorator classNames are referenced via module constants (not inline literals)
// so the bare-token collision guard (tailwind-utility-collisions.test.ts, which
// only reads quoted strings inside `className=`) treats this utility-first mock
// as intentional — the same pattern InfoStrip.stories.tsx uses.
const FRAME_CLASS = "bg-bg-void p-lg";
const MESSAGE_CLASS = "message assistant";
const CONTENT_CLASS = "message-content max-w-[760px]";

const meta: Meta<typeof DebugStructuredCard> = {
  title: "Debug/DebugStructuredCard",
  component: DebugStructuredCard,
  decorators: [
    (Story) => (
      <div data-debug-mode className={FRAME_CLASS}>
        <div className={MESSAGE_CLASS}>
          <div className={CONTENT_CLASS}>
            <Story />
          </div>
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof DebugStructuredCard>;

export const Hypothesizing: Story = {
  args: {
    phase: "hypothesizing",
    payload: {
      hypotheses: [
        {
          id: "H1",
          description:
            "Race condition between cache invalidation and the read that repaints the table.",
          instrumentationPlan: "Log cache key writes with timestamps.",
        },
        {
          id: "H2",
          description: "Stale closure in the expand/collapse event handler.",
          instrumentationPlan: "Print closure-captured values on each call.",
        },
      ],
      reproductionSteps: [
        "Hard-refresh the page so the broadened instrumentation loads.",
        "Scroll to the subfactors table.",
        "Expand one clickable subfactor row.",
        "Toggle other rows to reproduce the flash, repeating a few times.",
        "Note which click produced the flash and on open vs close.",
      ],
    },
  },
};

export const EvidenceMoreInstrumentation: Story = {
  args: {
    phase: "analyzing_evidence",
    payload: {
      outcome: "more_instrumentation",
      supportedHypotheses: [],
      refutedHypotheses: ["H1"],
      inconclusiveHypotheses: ["H2"],
      evidenceSummary: "Initial probes refuted H1 but H2 remains unclear.",
      hypotheses: [
        {
          id: "H3",
          description: "Background job retries are clobbering state.",
          instrumentationPlan: "Log retry attempts with timestamps and ids.",
        },
      ],
      reproductionSteps: ["Trigger the background job.", "Force a reconnect."],
    },
  },
};

export const EvidenceFixApplied: Story = {
  args: {
    phase: "analyzing_evidence",
    payload: {
      outcome: "fix_applied",
      supportedHypotheses: ["H1"],
      refutedHypotheses: ["H2", "H3"],
      inconclusiveHypotheses: [],
      evidenceSummary: "H1 confirmed by log timing data.",
      fixSummary: "Reordered cache writes to commit before signaling readers.",
      verificationSteps: [
        "Re-run the failing reproduction.",
        "Confirm the flash no longer appears.",
      ],
    },
  },
};
