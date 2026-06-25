import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "./Collapsible";

const meta = {
  title: "UI/Collapsible",
  component: Collapsible,
  parameters: {
    // a11y enforced: the trigger is a real button with aria-expanded/controls and
    // a canonical cyan focus-visible ring; the region carries role + id wiring
    // from Radix. "error" fails the Storybook test project on any violation.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Collapsible>;

export default meta;
type Story = StoryObj<typeof meta>;

// A bordered card frame so the in-flow disclosure reads as a real CC surface.
function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="w-[360px] overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-surface">
      {children}
    </div>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle px-md py-sm font-mono text-[0.78rem] text-text-secondary">
      {children}
    </div>
  );
}

/** Default: one trigger, one region, closed to start. Click / Enter / Space toggles. */
export const SimpleDisclosure: Story = {
  render: () => (
    <Frame>
      <Collapsible>
        <CollapsibleTrigger>
          <span className="font-mono text-[0.78rem] font-medium tracking-[0.04em] uppercase">
            Advanced options
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Body>
            Three settings live in here. They are hidden until you ask.
          </Body>
        </CollapsibleContent>
      </Collapsible>
    </Frame>
  ),
};

/** Open on first paint via defaultOpen — the region is reviewable without interaction. */
export const StaticOpen: Story = {
  render: () => (
    <Frame>
      <Collapsible defaultOpen>
        <CollapsibleTrigger>
          <span className="font-mono text-[0.78rem] font-medium tracking-[0.04em] uppercase">
            Advanced options
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Body>
            Rendered open: the chevron points up and the region is visible.
          </Body>
        </CollapsibleContent>
      </Collapsible>
    </Frame>
  ),
};

/** Long content scrolls naturally in flow — the primitive imposes no height cap. */
export const LongContent: Story = {
  render: () => (
    <Frame>
      <Collapsible defaultOpen>
        <CollapsibleTrigger>
          <span className="font-mono text-[0.78rem] font-medium tracking-[0.04em] uppercase">
            Release notes
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Body>
            <ul className="m-0 flex list-disc flex-col gap-xs pl-md">
              {Array.from({ length: 10 }, (_, i) => (
                <li key={i}>Change number {i + 1} that shipped this week.</li>
              ))}
            </ul>
          </Body>
        </CollapsibleContent>
      </Collapsible>
    </Frame>
  ),
};

/** Disabled: the trigger is inert (dimmed, not-allowed cursor) and cannot open. */
export const Disabled: Story = {
  render: () => (
    <Frame>
      <Collapsible disabled>
        <CollapsibleTrigger>
          <span className="font-mono text-[0.78rem] font-medium tracking-[0.04em] uppercase">
            Locked section
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Body>You should never see this — the trigger is disabled.</Body>
        </CollapsibleContent>
      </Collapsible>
    </Frame>
  ),
};

/** Nested disclosures: a Collapsible inside another Collapsible's region. */
export const NestedContent: Story = {
  render: () => (
    <Frame>
      <Collapsible defaultOpen>
        <CollapsibleTrigger>
          <span className="font-mono text-[0.78rem] font-medium tracking-[0.04em] uppercase">
            Build settings
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle pl-md">
            <Collapsible>
              <CollapsibleTrigger>
                <span className="font-mono text-[0.72rem] text-text-secondary">
                  Environment variables
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Body>
                  <span className="pl-md">NODE_ENV=production</span>
                </Body>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Frame>
  ),
};

/** hideChevron: the consumer supplies its own indicator instead of the built-in chevron. */
export const CustomIndicator: Story = {
  render: () => (
    <Frame>
      <Collapsible>
        <CollapsibleTrigger hideChevron>
          <span
            aria-hidden
            className="font-mono text-[0.85rem] text-text-tertiary transition-transform duration-150 group-data-[state=open]:rotate-90"
          >
            ▸
          </span>
          <span className="font-mono text-[0.78rem] font-medium tracking-[0.04em] uppercase">
            Details
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Body>
            The glyph on the left rotates via group-data-[state=open].
          </Body>
        </CollapsibleContent>
      </Collapsible>
    </Frame>
  ),
};

/**
 * Header row hosting a sibling control (`asChild`): the trigger is one flex
 * child and an independent interactive control (here a mock toggle standing in
 * for a Switch) is a sibling — NOT nested inside the trigger button, which would
 * be invalid. Unblocks the McpServerCard header restructure.
 */
export const HeaderWithSiblingControl: Story = {
  render: () => (
    <Frame>
      <Collapsible>
        <div className="flex items-center gap-sm px-md py-sm">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 cursor-pointer items-center gap-sm border-0 bg-transparent text-left font-mono text-[0.78rem] font-medium tracking-[0.04em] text-text-secondary uppercase outline-none hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]"
            >
              <span
                aria-hidden
                className="text-text-tertiary transition-transform duration-150 group-data-[state=open]:rotate-90"
              >
                ▸
              </span>
              filesystem
            </button>
          </CollapsibleTrigger>
          <button
            type="button"
            role="switch"
            aria-checked="true"
            aria-label="Enable server"
            className="h-[18px] w-[32px] cursor-pointer rounded-full border-0 bg-cyan outline-none focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px]"
          />
        </div>
        <CollapsibleContent>
          <Body>3 tools exposed by this server.</Body>
        </CollapsibleContent>
      </Collapsible>
    </Frame>
  ),
};
