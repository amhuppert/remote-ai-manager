import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsTriggerCount,
  Tabs,
  Tab,
  TabCount,
} from "./Tabs";

const meta = {
  title: "UI/Tabs",
  component: TabsRoot,
  parameters: {
    // Triggers/counts/labels meet WCAG AA on the strip surface (the inactive
    // count inherits the tab colour rather than fading via opacity). a11y is
    // enforced ("error" fails the Storybook test project on any violation).
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof TabsRoot>;

export default meta;
type Story = StoryObj<typeof meta>;

// Panel chrome lives on an inner element — `layoutClassName` on `TabsContent` is
// layout-only, so the body's appearance is owned here in the story.
function Panel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="w-[360px] rounded-md border border-solid border-border-default bg-bg-surface p-4 font-mono text-[0.78rem] text-text-primary">
      {children}
    </div>
  );
}

const tabs = [
  {
    value: "diff",
    label: "Diff",
    count: 3,
    body: "Uncommitted changes panel.",
  },
  { value: "docs", label: "Docs", count: 12, body: "Documentation panel." },
  { value: "specs", label: "Specs", count: 0, body: "Specifications panel." },
];

/**
 * True APG tabs: Arrow/Home/End move between triggers, the matching panel swaps,
 * each trigger carries a count badge that takes the tab colour when active.
 */
export const PanelSwitcher: Story = {
  render: () => {
    const [value, setValue] = useState("diff");
    return (
      <TabsRoot value={value} onValueChange={setValue}>
        <TabsList aria-label="Right pane">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>
              {t.label}
              <TabsTriggerCount>{t.count}</TabsTriggerCount>
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t.value} value={t.value} layoutClassName="mt-3">
            <Panel>{t.body}</Panel>
          </TabsContent>
        ))}
      </TabsRoot>
    );
  },
};

/** A disabled trigger dims and cannot be focused or activated. */
export const DisabledTrigger: Story = {
  render: () => (
    <TabsRoot defaultValue="diff">
      <TabsList aria-label="Right pane">
        <TabsTrigger value="diff">Diff</TabsTrigger>
        <TabsTrigger value="docs">Docs</TabsTrigger>
        <TabsTrigger value="specs" disabled>
          Specs
        </TabsTrigger>
      </TabsList>
      <TabsContent value="diff" layoutClassName="mt-3">
        <Panel>Uncommitted changes panel.</Panel>
      </TabsContent>
      <TabsContent value="docs" layoutClassName="mt-3">
        <Panel>Documentation panel.</Panel>
      </TabsContent>
      <TabsContent value="specs" layoutClassName="mt-3">
        <Panel>Specifications panel.</Panel>
      </TabsContent>
    </TabsRoot>
  ),
};

/**
 * Mobile/touch spine: `fill` centres each label and grows the trigger to a 36px
 * touch target; the parent supplies equal-split geometry via `layoutClassName`.
 */
export const FillTouch: Story = {
  render: () => (
    <div style={{ width: 320 }}>
      <TabsRoot defaultValue="diff">
        <TabsList aria-label="Right pane" layoutClassName="w-full">
          {tabs.map((t) => (
            <TabsTrigger
              key={t.value}
              value={t.value}
              fill
              layoutClassName="grow shrink basis-0"
            >
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {tabs.map((t) => (
          <TabsContent key={t.value} value={t.value} layoutClassName="mt-3">
            <Panel>{t.body}</Panel>
          </TabsContent>
        ))}
      </TabsRoot>
    </div>
  ),
};

/** Static review: the active panel renders with no interaction needed. */
export const StaticReview: Story = {
  render: () => (
    <TabsRoot defaultValue="docs">
      <TabsList aria-label="Right pane">
        {tabs.map((t) => (
          <TabsTrigger key={t.value} value={t.value}>
            {t.label}
            <TabsTriggerCount>{t.count}</TabsTriggerCount>
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.value} value={t.value} layoutClassName="mt-3">
          <Panel>{t.body}</Panel>
        </TabsContent>
      ))}
    </TabsRoot>
  ),
};

// ---------------------------------------------------------------------------
// Presentational segmented recipe (NOT APG tabs — a value-picker look). Retained
// transitionally; do not confuse with the panel-switching tabs above.
// ---------------------------------------------------------------------------

const segItems = [
  { id: "active", label: "Active", count: 3 },
  { id: "idle", label: "Idle", count: 12 },
  { id: "archived", label: "Archived", count: 0 },
];

/** Presentational segmented strip — selects a value, does not switch a panel. */
export const SegmentedRecipe: Story = {
  render: () => {
    const [active, setActive] = useState("active");
    return (
      <Tabs>
        {segItems.map((it) => {
          const isActive = it.id === active;
          return (
            <Tab key={it.id} active={isActive} onClick={() => setActive(it.id)}>
              {it.label}
              <TabCount active={isActive}>{it.count}</TabCount>
            </Tab>
          );
        })}
      </Tabs>
    );
  },
};

// ===========================================================================
// Unstyled (`asChild`) escape-hatch stories — a bespoke tabset keeps Radix tab
// behaviour while supplying its own appearance. These unblock the deferred
// consumers (AgentCapabilitiesConfigurator grouped underline tabs, ConfigPage
// vertical settings nav). The consumer owns the appearance on its own elements;
// the primitive contributes only the role/roving-focus/aria wiring.
// ===========================================================================

const navSections = [
  {
    value: "general",
    label: "General",
    body: "Workspace + appearance settings.",
  },
  { value: "agents", label: "Agents", body: "Backend + model configuration." },
  { value: "advanced", label: "Advanced", body: "Experimental toggles." },
];

/**
 * Vertical settings nav (`orientation="vertical"` + `asChild`): Up/Down arrows
 * move between items, the matching section swaps. The nav column and each item
 * carry a bespoke appearance the cc-tab pill strip can't reproduce.
 */
export const VerticalNav: Story = {
  render: () => {
    const [value, setValue] = useState("general");
    return (
      <TabsRoot
        orientation="vertical"
        value={value}
        onValueChange={setValue}
        layoutClassName="flex"
      >
        <TabsList asChild aria-label="Settings">
          <nav className="mr-4 flex w-[160px] flex-col gap-[2px]">
            {navSections.map((s) => (
              <TabsTrigger asChild key={s.value} value={s.value}>
                <button
                  type="button"
                  className="cursor-pointer rounded-sm border-0 bg-transparent px-md py-sm text-left font-mono text-[0.78rem] text-text-secondary outline-none hover:bg-bg-hover hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] data-[state=active]:bg-bg-hover data-[state=active]:text-text-primary data-[state=active]:[box-shadow:inset_2px_0_0_var(--color-cyan)]"
                >
                  {s.label}
                </button>
              </TabsTrigger>
            ))}
          </nav>
        </TabsList>
        {navSections.map((s) => (
          <TabsContent key={s.value} value={s.value} layoutClassName="flex-1">
            <Panel>{s.body}</Panel>
          </TabsContent>
        ))}
      </TabsRoot>
    );
  },
};

const groupedTabs = [
  { group: "Shared", value: "files", label: "Files" },
  { group: "Shared", value: "search", label: "Search" },
  { group: "Agents", value: "claude", label: "Claude" },
  { group: "Agents", value: "codex", label: "Codex" },
];

/**
 * Grouped underline tabs (`asChild`): non-interactive group labels interleave
 * between triggers without breaking roving focus (Arrow nav skips them). The
 * active tab is marked with a bottom-border accent, not the pill recipe.
 */
export const GroupedUnderlineTabs: Story = {
  render: () => {
    const [value, setValue] = useState("files");
    let lastGroup = "";
    return (
      <TabsRoot
        value={value}
        onValueChange={setValue}
        layoutClassName="w-[420px]"
      >
        <TabsList asChild aria-label="Capabilities">
          <div className="flex items-end gap-md border-x-0 border-t-0 border-b border-solid border-border-default">
            {groupedTabs.map((t) => {
              const showGroup = t.group !== lastGroup;
              lastGroup = t.group;
              return (
                <div key={t.value} className="flex items-end gap-md">
                  {showGroup && (
                    <span className="pb-sm font-mono text-[0.65rem] tracking-[0.08em] text-text-tertiary uppercase">
                      {t.group}
                    </span>
                  )}
                  <TabsTrigger asChild value={t.value}>
                    <button
                      type="button"
                      className="-mb-px cursor-pointer border-x-0 border-t-0 border-b-2 border-solid border-transparent bg-transparent px-xs py-sm font-mono text-[0.78rem] text-text-secondary outline-none hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:2px] data-[state=active]:border-cyan data-[state=active]:text-text-primary"
                    >
                      {t.label}
                    </button>
                  </TabsTrigger>
                </div>
              );
            })}
          </div>
        </TabsList>
        {groupedTabs.map((t) => (
          <TabsContent key={t.value} value={t.value} layoutClassName="mt-4">
            <Panel>{t.label} capability panel.</Panel>
          </TabsContent>
        ))}
      </TabsRoot>
    );
  },
};
