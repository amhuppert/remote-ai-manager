import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { cn } from "@/lib/ui/cn";
import { EffortLabel } from "./EffortLabel";

const meta = {
  title: "Conversation/EffortLabel",
  component: EffortLabel,
  parameters: { layout: "padded" },
  args: { effort: "max" },
} satisfies Meta<typeof EffortLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

// Mirrors MessageRow's message-metadata markup (role label + `· model · effort`)
// so the label renders in its real conversation-panel context. The class strings
// match MessageRow's metadata row; only the effort cell is the real EffortLabel.
const ROLE_CLASS =
  "font-mono text-[0.7rem] font-bold uppercase tracking-[0.1em]";
const META_CLASS =
  "inline text-[0.7rem] font-medium tracking-[0.02em] normal-case";

function MetaRow({
  role,
  roleColor,
  model,
  effort,
}: {
  role: string;
  roleColor: string;
  model: string;
  effort?: string;
}): React.JSX.Element {
  return (
    <div className={cn(ROLE_CLASS, roleColor)}>
      {role}
      <span className={META_CLASS}>
        <span className="mx-[5px] text-text-tertiary">&middot;</span>
        <span className="text-text-secondary">{model}</span>
        {effort && (
          <>
            <span className="mx-[5px] text-text-tertiary">&middot;</span>
            <EffortLabel effort={effort} />
          </>
        )}
      </span>
    </div>
  );
}

/**
 * The label in its real context — a conversation message's `role · model · effort`
 * metadata line. The Max and XHigh tiers exceed the scale and render as animated
 * rainbow gradient text; lower tiers and effort-less models render plain.
 */
export const Metadata: Story = {
  render: () => (
    <div className="flex flex-col gap-md">
      <MetaRow role="Claude" roleColor="text-cyan" model="Opus" effort="max" />
      <MetaRow
        role="Codex"
        roleColor="text-violet"
        model="GPT-5.4"
        effort="xhigh"
      />
      <MetaRow role="Claude" roleColor="text-cyan" model="Opus" effort="high" />
      <MetaRow role="Claude" roleColor="text-cyan" model="Sonnet" />
    </div>
  ),
};

/** Every effort tier side by side — only Max and XHigh take the rainbow treatment. */
export const Tiers: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-lg font-mono text-[0.72rem] font-medium">
      {["minimal", "low", "medium", "high", "xhigh", "max"].map((e) => (
        <EffortLabel key={e} effort={e} />
      ))}
    </div>
  ),
};
