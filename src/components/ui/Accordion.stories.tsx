import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "./Accordion";

const meta = {
  title: "UI/Accordion",
  component: Accordion,
  parameters: {
    // a11y enforced: header buttons carry aria-expanded/controls + roving focus,
    // panels are role=region wired to their header. "error" fails the Storybook
    // test project on any violation.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Accordion>;

export default meta;
// `Accordion` props are a discriminated union over `type` (single | multiple),
// which defeats `StoryObj<typeof meta>` arg inference; these stories are
// render-only, so the untyped `StoryObj` is the correct fit.
type Story = StoryObj;

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[0.78rem] font-medium tracking-[0.04em] uppercase">
      {children}
    </span>
  );
}

function Body({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-md pt-0 pb-md font-mono text-[0.78rem] text-text-secondary">
      {children}
    </div>
  );
}

/** type="single" + collapsible: one section open at a time; the open one can be closed. */
export const Single: Story = {
  render: () => (
    <Accordion type="single" collapsible layoutClassName="w-[400px]">
      <AccordionItem value="overview">
        <AccordionTrigger>
          <Label>Overview</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>A short summary of the feature and what it does.</Body>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="requirements">
        <AccordionTrigger>
          <Label>Requirements</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>EARS-format requirements live here.</Body>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="tasks">
        <AccordionTrigger>
          <Label>Tasks</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>The implementation checklist for this spec.</Body>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

/** type="multiple": sections open independently and stay open together. */
export const Multiple: Story = {
  render: () => (
    <Accordion type="multiple" layoutClassName="w-[400px]">
      <AccordionItem value="a">
        <AccordionTrigger>
          <Label>First group</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>Open me and the others stay as they were.</Body>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="b">
        <AccordionTrigger>
          <Label>Second group</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>Independent of the first.</Body>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

/** defaultValue renders a section open on first paint (reviewable without interaction). */
export const StaticOpen: Story = {
  render: () => (
    <Accordion
      type="single"
      collapsible
      defaultValue="requirements"
      layoutClassName="w-[400px]"
    >
      <AccordionItem value="overview">
        <AccordionTrigger>
          <Label>Overview</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>Closed.</Body>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="requirements">
        <AccordionTrigger>
          <Label>Requirements</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>
            Open on load: the chevron points up, the panel is visible.
          </Body>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

/** A disabled item: its header is inert (dimmed, not-allowed) and skipped by focus. */
export const DisabledItem: Story = {
  render: () => (
    <Accordion type="single" collapsible layoutClassName="w-[400px]">
      <AccordionItem value="enabled">
        <AccordionTrigger>
          <Label>Enabled</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>This one opens.</Body>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="locked" disabled>
        <AccordionTrigger>
          <Label>Locked</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>Unreachable — the trigger is disabled.</Body>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

/** Nested: an Accordion section whose panel contains its own Accordion. */
export const NestedContent: Story = {
  render: () => (
    <Accordion
      type="single"
      collapsible
      defaultValue="outer"
      layoutClassName="w-[400px]"
    >
      <AccordionItem value="outer">
        <AccordionTrigger>
          <Label>Steering</Label>
        </AccordionTrigger>
        <AccordionContent>
          <div className="p-sm">
            <Accordion type="single" collapsible>
              <AccordionItem value="inner-a">
                <AccordionTrigger>
                  <span className="font-mono text-[0.72rem] text-text-secondary">
                    product.md
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <Body>Nested panel content.</Body>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="inner-b">
                <AccordionTrigger>
                  <span className="font-mono text-[0.72rem] text-text-secondary">
                    tech.md
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <Body>Another nested panel.</Body>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </AccordionContent>
      </AccordionItem>
      <AccordionItem value="specs">
        <AccordionTrigger>
          <Label>Specs</Label>
        </AccordionTrigger>
        <AccordionContent>
          <Body>Sibling section, closed.</Body>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  ),
};

// ===========================================================================
// Unstyled (`asChild`) escape-hatch stories — a structurally-bespoke accordion
// keeps Radix single-open/roving-focus/aria behaviour while supplying its own
// appearance on every part. Unblocks CommitHistory (grid header) and SpecBrowser
// feature groups (flat borderless list).
// ===========================================================================

const commits = [
  {
    value: "c1",
    hash: "be08a0aa",
    subject: "Graph workflow join context_merge",
  },
  {
    value: "c2",
    hash: "367b42be",
    subject: "Graph workflow context disclosure",
  },
  {
    value: "c3",
    hash: "02a9a0d7",
    subject: "Graph workflow context primitive",
  },
];

/**
 * Grid-header timeline (`asChild` on root/item/trigger/content): each header is a
 * CSS-grid button (hash · subject) the baked flex recipe can't lay out; the root
 * and items carry a bespoke borderless rail instead of the card frame.
 */
export const BespokeGridHeader: Story = {
  render: () => (
    <Accordion type="single" collapsible asChild>
      <div className="flex w-[420px] flex-col">
        {commits.map((c) => (
          <AccordionItem key={c.value} value={c.value} asChild>
            <div className="border-x-0 border-t-0 border-b border-solid border-border-subtle">
              <AccordionTrigger asChild>
                <button
                  type="button"
                  className="grid w-full cursor-pointer grid-cols-[auto_1fr] items-center gap-md border-0 bg-transparent px-md py-sm text-left outline-none hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]"
                >
                  <code className="font-mono text-[0.72rem] text-cyan">
                    {c.hash}
                  </code>
                  <span className="truncate font-mono text-[0.78rem] text-text-secondary">
                    {c.subject}
                  </span>
                </button>
              </AccordionTrigger>
              <AccordionContent asChild>
                <div className="px-md pt-0 pb-md font-mono text-[0.72rem] text-text-tertiary">
                  Diff for {c.hash} loads lazily on expand.
                </div>
              </AccordionContent>
            </div>
          </AccordionItem>
        ))}
      </div>
    </Accordion>
  ),
};

const featureGroups = [
  { value: "auth", label: "auth", specs: ["requirements.md", "design.md"] },
  { value: "billing", label: "billing", specs: ["requirements.md"] },
];

/**
 * Flat borderless group list (`asChild`): the feature groups render as a flat
 * stack inside a scroll area — no card frame, no hairlines — while keeping the
 * single-open accordion behaviour.
 */
export const FlatGroupList: Story = {
  render: () => (
    <Accordion type="single" collapsible asChild defaultValue="auth">
      <div className="flex w-[280px] flex-col gap-[2px]">
        {featureGroups.map((g) => (
          <AccordionItem key={g.value} value={g.value} asChild>
            <div>
              <AccordionTrigger asChild>
                <button
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-sm border-0 bg-transparent px-sm py-xs text-left font-mono text-[0.78rem] text-text-secondary outline-none hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px]"
                >
                  <span
                    aria-hidden
                    className="text-text-tertiary transition-transform duration-150 group-data-[state=open]:rotate-90"
                  >
                    ▸
                  </span>
                  {g.label}
                </button>
              </AccordionTrigger>
              {/* The asChild region element is a generic container, NOT the
                  <ul> itself: Radix sets role="region" on the content element,
                  which would override a <ul>'s implicit list role and orphan its
                  <li> children (axe `listitem`). Nest the list inside instead. */}
              <AccordionContent asChild>
                <div className="py-xs pl-lg">
                  <ul className="m-0 flex list-none flex-col">
                    {g.specs.map((s) => (
                      <li
                        key={s}
                        className="py-xs font-mono text-[0.72rem] text-text-tertiary"
                      >
                        {s}
                      </li>
                    ))}
                  </ul>
                </div>
              </AccordionContent>
            </div>
          </AccordionItem>
        ))}
      </div>
    </Accordion>
  ),
};
