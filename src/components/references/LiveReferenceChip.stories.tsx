import { createContext, useContext, useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Button } from "@/components/ui/Button";
import { createLiveReferenceChip } from "./LiveReferenceChip";
import type {
  LiveReferenceResult,
  LiveReferenceTarget,
} from "@/lib/live-references/schemas";

type Mode = "ready" | "loading" | "missing" | "stale";
const Scenario = createContext({ mode: "ready" as Mode, done: false });
const targets: Record<LiveReferenceTarget["kind"], LiveReferenceTarget> = {
  ticket: { kind: "ticket", projectName: "command-center", id: "90" },
  conversation: {
    kind: "conversation",
    projectName: "command-center",
    id: "conv-42",
  },
  execution: {
    kind: "execution",
    projectName: "command-center",
    sessionName: "notepad-live-chips",
    id: "eca05bca-951a-4fb0",
  },
};
const names = {
  ticket: "Notepad capture",
  conversation: "Capture verification",
  execution: "Deliver Notepad capture",
};
const Chip = createLiveReferenceChip({
  useReference(target) {
    const { mode, done } = useContext(Scenario);
    const data: LiveReferenceResult = {
      target,
      checkedAt: "2026-09-10T04:30:00.000Z",
      unavailableReason: mode === "missing" ? "missing" : null,
      summary:
        mode === "missing"
          ? null
          : {
              title: names[target.kind],
              identity: target.kind === "ticket" ? "CC#90" : target.id,
              status:
                target.kind === "ticket"
                  ? done
                    ? "Done"
                    : "In Progress"
                  : target.kind === "conversation"
                    ? "Waiting for input"
                    : "Running",
              tone:
                target.kind === "ticket" && done
                  ? "green"
                  : target.kind === "conversation"
                    ? "amber"
                    : "cyan",
              attentionCount: target.kind === "execution" ? 1 : 0,
              href: "#destination",
              readCommand: "cctl ticket get command-center#90",
              details:
                target.kind === "execution"
                  ? [
                      { label: "Project", value: "command-center" },
                      { label: "Session", value: "notepad-live-chips" },
                      {
                        label: "Activity",
                        value:
                          "Implementation running · verification awaiting you",
                      },
                      {
                        label: "Awaiting you",
                        value: "Verification · context approval",
                      },
                    ]
                  : target.kind === "conversation"
                    ? [
                        { label: "Project", value: "command-center" },
                        { label: "Scope", value: "notepad-live-chips" },
                        { label: "Agent", value: "codex" },
                        { label: "Last activity", value: "2026-09-10 00:30" },
                      ]
                    : [
                        { label: "Project", value: "command-center" },
                        { label: "Work type", value: "feature" },
                      ],
            },
    };
    return {
      data: mode === "loading" ? undefined : data,
      isError: mode === "stale",
    };
  },
});

function Dashboard({ mode = "ready" }: { mode?: Mode }) {
  const [done, setDone] = useState(false);
  return (
    <Scenario.Provider value={{ mode, done }}>
      <div className="mx-auto max-w-[920px] font-mono text-[0.8rem] text-text-primary">
        <div className="flex items-center justify-between gap-md border-x-0 border-t-0 border-b border-solid border-border-subtle pb-md">
          <div>
            <div className="text-[0.7rem] tracking-wider text-text-secondary uppercase">
              Notepad
            </div>
            <h1 className="mt-xs mb-0 text-[1.1rem] font-semibold">
              Release desk
            </h1>
          </div>
          <span className="text-[0.7rem] text-text-tertiary">Saved</span>
        </div>
        <div className="flex flex-col gap-xl py-xl">
          <p className="m-0 leading-loose">
            Keep the capture work in view while the agents finish verification.
          </p>
          <div className="flex flex-col gap-md">
            <div className="text-[0.7rem] tracking-wider text-text-secondary uppercase">
              Shipping
            </div>
            <div>
              <Chip
                target={targets.ticket}
                title={names.ticket}
                identity="CC#90"
                reference="ticket reference"
              />
            </div>
            <p className="m-0 leading-loose text-text-secondary">
              Check voice capture and clipping before closing the ticket.
            </p>
          </div>
          <div className="flex flex-col gap-md">
            <div className="text-[0.7rem] tracking-wider text-text-secondary uppercase">
              Agent conversations
            </div>
            <div>
              <Chip
                target={targets.conversation}
                title={names.conversation}
                identity="conv-42"
                reference="conversation reference"
              />
            </div>
          </div>
          <div className="flex flex-col gap-md">
            <div className="text-[0.7rem] tracking-wider text-text-secondary uppercase">
              Delivery
            </div>
            <div>
              <Chip
                target={targets.execution}
                title={names.execution}
                identity="eca05bca"
                reference="execution reference"
              />
            </div>
          </div>
          <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle pt-lg">
            <Button size="sm" onClick={() => setDone(!done)}>
              {done ? "Reopen ticket" : "Complete ticket"}
            </Button>
          </div>
        </div>
      </div>
    </Scenario.Provider>
  );
}

const meta = {
  title: "References/Live chips",
  component: Dashboard,
  parameters: { layout: "padded" },
} satisfies Meta<typeof Dashboard>;
export default meta;
type Story = StoryObj<typeof meta>;
export const NotepadDashboard: Story = {};
export const Loading: Story = { args: { mode: "loading" } };
export const Unavailable: Story = { args: { mode: "missing" } };
export const Stale: Story = { args: { mode: "stale" } };
