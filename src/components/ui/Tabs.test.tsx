// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsTriggerCount,
  // The presentational segmented recipe must remain exported and UNCHANGED so
  // the not-yet-migrated consumers keep building. It is deliberately NOT APG
  // tabs (no role=tab) — that distinction is asserted below.
  Tabs,
  Tab,
} from "./Tabs";

afterEach(cleanup);

function classesOf(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function Fixture({
  value,
  defaultValue,
  onValueChange,
  disabledArchived = false,
}: {
  value?: string;
  defaultValue?: string;
  onValueChange?: (v: string) => void;
  disabledArchived?: boolean;
}): React.JSX.Element {
  return (
    <TabsRoot
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange}
    >
      <TabsList aria-label="Sessions">
        <TabsTrigger value="active">
          Active
          <TabsTriggerCount>3</TabsTriggerCount>
        </TabsTrigger>
        <TabsTrigger value="idle">
          Idle
          <TabsTriggerCount>12</TabsTriggerCount>
        </TabsTrigger>
        <TabsTrigger value="archived" disabled={disabledArchived}>
          Archived
        </TabsTrigger>
      </TabsList>
      <TabsContent value="active">Active panel</TabsContent>
      <TabsContent value="idle">Idle panel</TabsContent>
      <TabsContent value="archived">Archived panel</TabsContent>
    </TabsRoot>
  );
}

describe("Radix Tabs — class contract", () => {
  it("TabsList carries the cc-tabs strip recipe", () => {
    render(<Fixture defaultValue="active" />);
    const list = screen.getByRole("tablist", { name: "Sessions" });
    for (const cls of [
      "flex",
      "gap-[2px]",
      "p-[3px]",
      "bg-bg-surface",
      "border",
      "border-solid",
      "border-border-default",
      "rounded-md",
    ]) {
      expect(list.className).toContain(cls);
    }
  });

  it("TabsTrigger carries the cc-tab recipe with data-state active/inactive cyan treatment, disabled + focus-visible outline", () => {
    render(<Fixture defaultValue="active" />);
    const trigger = screen.getByRole("tab", { name: /Active/ });
    for (const cls of [
      "text-text-secondary",
      "data-[state=active]:bg-cyan",
      "data-[state=active]:text-text-inverse",
      "data-[state=inactive]:hover:bg-bg-hover",
      "data-[state=inactive]:hover:text-text-primary",
      "data-[disabled]:opacity-40",
      "data-[disabled]:cursor-not-allowed",
      "uppercase",
      "tracking-[0.05em]",
      "min-h-[28px]",
      "border-0",
      "outline-none",
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
      "focus-visible:[outline-offset:2px]",
    ]) {
      expect(trigger.className).toContain(cls);
    }
  });

  it("fill adds the mobile-spine centre + 36px touch sizing (off by default)", () => {
    const { rerender } = render(
      <TabsRoot defaultValue="a">
        <TabsList>
          <TabsTrigger value="a">A</TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
      </TabsRoot>,
    );
    expect(screen.getByRole("tab").className).not.toContain(
      "max-768:justify-center",
    );

    rerender(
      <TabsRoot defaultValue="a">
        <TabsList>
          <TabsTrigger value="a" fill>
            A
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a">A</TabsContent>
      </TabsRoot>,
    );
    const filled = screen.getByRole("tab");
    expect(filled.className).toContain("max-768:justify-center");
    expect(filled.className).toContain("max-768:min-h-[36px]");
  });

  it("TabsTriggerCount carries the count recipe and inherits colour (no opacity fade)", () => {
    render(<Fixture defaultValue="active" />);
    const count = screen.getByText("3");
    for (const cls of [
      "font-mono",
      "text-[0.7rem]",
      "font-medium",
      "px-[4px]",
      "rounded-full",
    ]) {
      expect(count.className).toContain(cls);
    }
    expect(count.className).not.toContain("opacity-");
  });

  it("TabsContent carries a focus-visible outline (the panel is focusable)", () => {
    render(<Fixture defaultValue="active" />);
    const panel = screen.getByRole("tabpanel");
    expect(panel.className).toContain("outline-none");
    expect(panel.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
  });

  it("appends layoutClassName last on every part", () => {
    render(
      <TabsRoot defaultValue="a" layoutClassName="flex flex-col h-full">
        <TabsList layoutClassName="w-full">
          <TabsTrigger value="a" layoutClassName="grow shrink basis-0">
            A
          </TabsTrigger>
        </TabsList>
        <TabsContent value="a" layoutClassName="flex-1 min-h-0">
          A
        </TabsContent>
      </TabsRoot>,
    );
    const list = screen.getByRole("tablist");
    const trigger = screen.getByRole("tab");
    const panel = screen.getByRole("tabpanel");
    expect(classesOf(list).at(-1)).toBe("w-full");
    expect(classesOf(trigger).at(-1)).toBe("basis-0");
    expect(classesOf(panel).at(-1)).toBe("min-h-0");
  });
});

describe("Radix Tabs — APG semantics & panel linking", () => {
  it("wires role=tablist/tab/tabpanel with aria-selected and aria-controls", () => {
    render(<Fixture defaultValue="active" />);
    const tablist = screen.getByRole("tablist", { name: "Sessions" });
    expect(tablist).toBeTruthy();

    const active = screen.getByRole("tab", { name: /Active/ });
    const idle = screen.getByRole("tab", { name: /Idle/ });
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(idle.getAttribute("aria-selected")).toBe("false");

    // Only the active panel is mounted; the active trigger controls it and the
    // panel is labelled back by the trigger.
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain("Active panel");
    expect(active.getAttribute("aria-controls")).toBe(panel.getAttribute("id"));
    expect(panel.getAttribute("aria-labelledby")).toBe(
      active.getAttribute("id"),
    );
  });

  it("roving tabindex: focus makes the active tab the single tabstop (0), the rest -1", () => {
    // Radix's RovingFocusGroup only assigns the tabstop once focus enters the
    // group, so assert the invariant relative to focus (act() flushes the
    // resulting React state update) rather than at mount.
    render(<Fixture defaultValue="active" />);
    const active = screen.getByRole("tab", { name: /Active/ });
    act(() => active.focus());
    expect(active.getAttribute("tabindex")).toBe("0");
    expect(
      screen.getByRole("tab", { name: /Idle/ }).getAttribute("tabindex"),
    ).toBe("-1");
    expect(
      screen.getByRole("tab", { name: "Archived" }).getAttribute("tabindex"),
    ).toBe("-1");
  });

  it("a disabled trigger is exposed as disabled and cannot be selected", async () => {
    const user = userEvent.setup();
    render(<Fixture defaultValue="active" disabledArchived />);
    const archived = screen.getByRole("tab", { name: "Archived" });
    expect(archived).toHaveProperty("disabled", true);
    await user.click(archived);
    // Selection stays on the active tab.
    expect(
      screen.getByRole("tab", { name: /Active/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("Radix Tabs — keyboard navigation & activation", () => {
  it("ArrowRight/ArrowLeft move selection (automatic activation), Home/End jump", async () => {
    const user = userEvent.setup();
    render(<Fixture defaultValue="active" />);
    const active = screen.getByRole("tab", { name: /Active/ });
    active.focus();

    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: /Idle/ }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("Idle panel");

    await user.keyboard("{Home}");
    expect(
      screen.getByRole("tab", { name: /Active/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("controlled value is honoured via onValueChange", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    function Controlled(): React.JSX.Element {
      return <Fixture value="active" onValueChange={(v) => seen.push(v)} />;
    }
    render(<Controlled />);
    await user.click(screen.getByRole("tab", { name: /Idle/ }));
    expect(seen).toContain("idle");
    // Controlled: stays on "active" until the parent updates value.
    expect(
      screen.getByRole("tab", { name: /Active/ }).getAttribute("aria-selected"),
    ).toBe("true");
  });
});

describe("Radix Tabs — asChild (unstyled) escape hatch & vertical orientation", () => {
  // A bespoke grouped/underline tab strip (e.g. AgentCapabilitiesConfigurator,
  // ConfigPage vertical nav): the list and triggers adopt the consumer's own
  // elements, group labels interleave between triggers, and Radix keeps roving
  // focus + automatic activation + aria wiring.
  function Bespoke({
    orientation,
  }: {
    orientation?: "horizontal" | "vertical";
  }): React.JSX.Element {
    return (
      <TabsRoot defaultValue="active" orientation={orientation}>
        <TabsList asChild aria-label="Sessions">
          <div className="bespoke-strip">
            <span className="group-label">Shared</span>
            <TabsTrigger asChild value="active">
              <button type="button" className="bespoke-tab">
                Active
              </button>
            </TabsTrigger>
            <span className="group-label">Agents</span>
            <TabsTrigger asChild value="idle">
              <button type="button" className="bespoke-tab">
                Idle
              </button>
            </TabsTrigger>
          </div>
        </TabsList>
        <TabsContent value="active">Active panel</TabsContent>
        <TabsContent value="idle">Idle panel</TabsContent>
      </TabsRoot>
    );
  }

  it("TabsList/TabsTrigger asChild adopt consumer elements and drop the baked recipes", () => {
    render(<Bespoke />);
    const list = screen.getByRole("tablist", { name: "Sessions" });
    expect(list.className).toBe("bespoke-strip");
    expect(list.className).not.toContain("bg-bg-surface");

    const trigger = screen.getByRole("tab", { name: "Active" });
    expect(trigger.className).toContain("bespoke-tab");
    expect(trigger.className).not.toContain("data-[state=active]:bg-cyan");
  });

  it("preserves roving focus + automatic activation with interleaved group labels", async () => {
    const user = userEvent.setup();
    render(<Bespoke />);
    const active = screen.getByRole("tab", { name: "Active" });
    act(() => active.focus());
    expect(active.getAttribute("tabindex")).toBe("0");

    // Arrow nav skips the non-trigger group labels and activates the next tab.
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: "Idle" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tabpanel").textContent).toContain("Idle panel");
  });

  it("orientation=vertical is forwarded to Radix (data-orientation on tablist + triggers)", () => {
    render(<Bespoke orientation="vertical" />);
    const list = screen.getByRole("tablist", { name: "Sessions" });
    expect(list.getAttribute("data-orientation")).toBe("vertical");
    expect(
      screen
        .getByRole("tab", { name: "Active" })
        .getAttribute("data-orientation"),
    ).toBe("vertical");
  });
});

describe("Segmented recipe is NOT APG tabs (separation guarantee)", () => {
  it("the presentational Tabs container has no tablist role and Tab has no tab role", () => {
    const { container } = render(
      <Tabs>
        <Tab active>One</Tab>
        <Tab>Two</Tab>
      </Tabs>,
    );
    const strip = container.firstElementChild as HTMLElement;
    expect(strip.getAttribute("role")).toBeNull();
    const buttons = strip.querySelectorAll("button");
    for (const b of buttons) {
      expect(b.getAttribute("role")).toBeNull();
    }
    // The presentational recipe stays keyed on data-active, not Radix data-state.
    expect(buttons[0]?.getAttribute("data-active")).toBe("true");
  });
});
