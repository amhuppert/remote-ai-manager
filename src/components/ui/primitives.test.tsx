// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Button } from "./Button";
import { Badge } from "./Badge";
import { StatusDot } from "./StatusDot";
import { Tabs, Tab, TabCount } from "./Tabs";
import {
  SectionHeader,
  SectionChevron,
  SectionLabel,
  SectionCount,
  SectionActions,
} from "./SectionHeader";
import { ModalShell, ModalTitle, ModalActions } from "./ModalShell";

/** Render an element and return its root DOM node for className assertions. */
function root(ui: React.ReactElement): HTMLElement {
  return render(ui).container.firstElementChild as HTMLElement;
}

function classes(el: HTMLElement): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function expectAll(el: HTMLElement, expected: string[]) {
  const present = new Set(classes(el));
  for (const c of expected)
    expect(present.has(c), `missing class: ${c}`).toBe(true);
}

describe("Button", () => {
  const baseSet = [
    "inline-flex",
    "items-center",
    "gap-sm",
    "rounded-md",
    "border",
    "border-solid",
    "font-mono",
    "transition-all",
    "duration-150",
    "ease-[ease]",
  ];

  it("renders the neutral default variant + md size parity set", () => {
    const el = root(<Button>Go</Button>);
    expectAll(el, [
      ...baseSet,
      "bg-bg-surface",
      "border-border-default",
      "text-text-primary",
      "font-medium",
      "hover:bg-bg-raised",
      "hover:border-border-strong",
      "px-[18px]",
      "py-[10px]",
      "text-[0.78rem]",
    ]);
  });

  it("renders the primary variant (cyan fill, semibold, hover glow)", () => {
    const el = root(<Button variant="primary">Save</Button>);
    expectAll(el, [
      "bg-cyan",
      "border-cyan",
      "text-text-inverse",
      "font-semibold",
      "hover:bg-cyan-dim",
      "hover:border-cyan-dim",
      "hover:shadow-[0_0_20px_var(--color-cyan-glow)]",
    ]);
  });

  it("renders the danger variant (transparent, red text, tokenized translucent border)", () => {
    const el = root(<Button variant="danger">Delete</Button>);
    expectAll(el, [
      "bg-transparent",
      "border-[var(--cc-red-border)]",
      "text-red",
      "hover:bg-red-glow",
      "hover:border-red-dim",
    ]);
  });

  it("renders the success variant", () => {
    const el = root(<Button variant="success">Merge</Button>);
    expectAll(el, [
      "bg-transparent",
      "border-[var(--cc-green-border)]",
      "text-green",
      "hover:bg-green-glow",
      "hover:border-green-dim",
    ]);
  });

  it("renders the ghost variant", () => {
    const el = root(<Button variant="ghost">Cancel</Button>);
    expectAll(el, [
      "bg-transparent",
      "border-transparent",
      "text-text-secondary",
      "hover:bg-bg-hover",
      "hover:border-border-default",
      "hover:text-cyan",
    ]);
  });

  it("applies the sm size and drops the md padding/size (no same-property conflict)", () => {
    const el = root(
      <Button variant="ghost" size="sm">
        x
      </Button>,
    );
    expectAll(el, ["px-[12px]", "py-[6px]", "text-[0.72rem]"]);
    expect(el.className).not.toContain("px-[18px]");
    expect(el.className).not.toContain("py-[10px]");
    expect(el.className).not.toContain("text-[0.78rem]");
  });

  it("appends layoutClassName last, after appearance utilities", () => {
    const el = root(
      <Button variant="primary" layoutClassName="ml-auto">
        Save
      </Button>,
    );
    expect(el.className.trim().endsWith("ml-auto")).toBe(true);
  });

  it("forwards native button attributes (children/onClick survive the Omit)", () => {
    const el = root(
      <Button type="submit" disabled aria-label="go">
        Go
      </Button>,
    );
    expect(el.getAttribute("type")).toBe("submit");
    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("go");
    expect(el.textContent).toBe("Go");
  });
});

describe("Badge", () => {
  const baseSet = [
    "inline-flex",
    "items-center",
    "justify-center",
    "font-mono",
    "text-[0.7rem]",
    "font-semibold",
    "px-[8px]",
    "py-[2px]",
    "rounded-full",
    "whitespace-nowrap",
    "leading-[1.3]",
  ];

  it("status idle is the default tier/value", () => {
    const el = root(<Badge>idle</Badge>);
    expect(el.getAttribute("data-status")).toBe("idle");
    expectAll(el, [...baseSet, "bg-bg-raised", "text-text-secondary"]);
  });

  it("status running gets the cyan glow + box-shadow", () => {
    const el = root(<Badge status="running">Running</Badge>);
    expect(el.getAttribute("data-status")).toBe("running");
    expectAll(el, [
      "bg-cyan-glow",
      "text-cyan",
      "shadow-[0_0_6px_var(--color-cyan-glow)]",
    ]);
  });

  it.each([
    ["merged", "bg-green-glow", "text-green"],
    ["ready", "bg-green-glow", "text-green"],
    ["awaiting", "bg-amber-glow", "text-amber"],
    ["warning", "bg-amber-glow", "text-amber"],
  ] as const)("status %s maps to its semantic color", (status, bg, text) => {
    const el = root(<Badge status={status}>x</Badge>);
    expect(el.getAttribute("data-status")).toBe(status);
    expectAll(el, [bg, text]);
  });

  it.each([
    ["feature", "bg-cyan-glow", "text-cyan"],
    ["bug", "bg-red-glow", "text-red"],
    ["idea", "bg-amber-glow", "text-amber"],
  ] as const)("type tier value %s", (kind, bg, text) => {
    const el = root(
      <Badge tier="type" kind={kind}>
        {kind}
      </Badge>,
    );
    expect(el.getAttribute("data-type")).toBe(kind);
    expectAll(el, [bg, text]);
  });

  it("count tier default vs active", () => {
    const off = root(<Badge tier="count">3</Badge>);
    expect(off.getAttribute("data-active")).toBe("false");
    expectAll(off, ["bg-bg-raised", "text-text-secondary"]);

    const on = root(
      <Badge tier="count" active>
        3
      </Badge>,
    );
    expect(on.getAttribute("data-active")).toBe("true");
    expectAll(on, ["bg-cyan-glow", "text-cyan"]);
  });

  it("backend identity overrides tier color (orthogonal)", () => {
    const claude = root(<Badge backend="claude">claude</Badge>);
    expect(claude.getAttribute("data-backend")).toBe("claude");
    expectAll(claude, ["bg-cyan-glow", "text-cyan"]);

    const codex = root(<Badge backend="codex">codex</Badge>);
    expect(codex.getAttribute("data-backend")).toBe("codex");
    expectAll(codex, ["bg-violet-glow", "text-violet"]);
  });

  it("subtle adds opacity-50 and layoutClassName is appended last", () => {
    const el = root(
      <Badge status="running" subtle layoutClassName="ml-1">
        x
      </Badge>,
    );
    expectAll(el, ["opacity-50"]);
    expect(el.className.trim().endsWith("ml-1")).toBe(true);
  });

  it("does not leak tier/status props onto the DOM node", () => {
    const el = root(<Badge tier="status" status="merged" id="b1" />);
    expect(el.hasAttribute("tier")).toBe(false);
    expect(el.hasAttribute("status")).toBe(false);
    expect(el.getAttribute("id")).toBe("b1");
  });
});

describe("StatusDot", () => {
  const baseSet = [
    "inline-block",
    "size-[7px]",
    "rounded-full",
    "animate-pulse-dot",
  ];

  it.each([
    [
      "green",
      "bg-green",
      "shadow-[0_0_8px_var(--color-green-glow),0_0_3px_var(--color-green)]",
    ],
    [
      "cyan",
      "bg-cyan",
      "shadow-[0_0_8px_var(--color-cyan-glow),0_0_3px_var(--color-cyan)]",
    ],
    [
      "amber",
      "bg-amber",
      "shadow-[0_0_8px_var(--color-amber-glow),0_0_3px_var(--color-amber)]",
    ],
    [
      "warning",
      "bg-amber",
      "shadow-[0_0_8px_var(--color-amber-glow),0_0_3px_var(--color-amber)]",
    ],
  ] as const)(
    "tone %s renders dot + double glow + pulse",
    (tone, bg, shadow) => {
      const el = root(<StatusDot tone={tone} />);
      expect(el.getAttribute("data-tone")).toBe(tone);
      expectAll(el, [...baseSet, bg, shadow]);
    },
  );

  it("defaults to green and appends layoutClassName", () => {
    const el = root(<StatusDot layoutClassName="mr-1" />);
    expect(el.getAttribute("data-tone")).toBe("green");
    expect(el.className.trim().endsWith("mr-1")).toBe(true);
  });
});

describe("Tabs / Tab / TabCount", () => {
  it("Tabs container parity set", () => {
    const el = root(<Tabs />);
    expectAll(el, [
      "flex",
      "gap-[2px]",
      "p-[3px]",
      "bg-bg-surface",
      "border",
      "border-solid",
      "border-border-default",
      "rounded-md",
    ]);
  });

  it("Tab carries both active + inactive-hover variants; data-active selects", () => {
    const inactive = root(<Tab>One</Tab>);
    expect(inactive.getAttribute("data-active")).toBe("false");
    expectAll(inactive, [
      "text-text-secondary",
      "data-[active=true]:bg-cyan",
      "data-[active=true]:text-text-inverse",
      "data-[active=false]:hover:bg-bg-hover",
      "data-[active=false]:hover:text-text-primary",
      "uppercase",
      "tracking-[0.05em]",
      "min-h-[28px]",
      "border-0",
    ]);

    const active = root(<Tab active>One</Tab>);
    expect(active.getAttribute("data-active")).toBe("true");
  });

  it("TabCount opacity steps with active", () => {
    const off = root(<TabCount>3</TabCount>);
    expect(off.getAttribute("data-active")).toBe("false");
    expectAll(off, [
      "opacity-[0.85]",
      "data-[active=true]:opacity-100",
      "rounded-full",
    ]);

    const on = root(<TabCount active>3</TabCount>);
    expect(on.getAttribute("data-active")).toBe("true");
  });
});

describe("SectionHeader and parts", () => {
  it("header container", () => {
    const el = root(<SectionHeader />);
    expectAll(el, [
      "flex",
      "items-center",
      "gap-sm",
      "min-h-[28px]",
      "mb-header-content",
    ]);
  });

  it("chevron rotates when collapsed (data-collapsed)", () => {
    const open = root(<SectionChevron />);
    expect(open.getAttribute("data-collapsed")).toBe("false");
    expectAll(open, [
      "size-[16px]",
      "text-text-secondary",
      "transition-transform",
      "shrink-0",
      "data-[collapsed=true]:-rotate-90",
    ]);

    const collapsed = root(<SectionChevron collapsed />);
    expect(collapsed.getAttribute("data-collapsed")).toBe("true");
  });

  it("label / count / actions parity sets", () => {
    expectAll(root(<SectionLabel>Sessions</SectionLabel>), [
      "font-mono",
      "text-[0.72rem]",
      "font-semibold",
      "uppercase",
      "tracking-[0.08em]",
      "text-text-secondary",
    ]);
    expectAll(root(<SectionCount>(3)</SectionCount>), [
      "text-[0.7rem]",
      "font-normal",
      "text-text-tertiary",
    ]);
    expectAll(root(<SectionActions />), [
      "flex",
      "items-center",
      "gap-xs",
      "ml-auto",
    ]);
  });
});

describe("ModalShell and parts", () => {
  it("overlay + default card parity sets; consumer a11y attrs reach the card", () => {
    const overlay = root(
      <ModalShell aria-label="Example dialog" role="dialog">
        body
      </ModalShell>,
    );
    expectAll(overlay, [
      "fixed",
      "inset-0",
      "z-dropdown",
      "flex",
      "items-center",
      "justify-center",
      "bg-[var(--cc-overlay-scrim)]",
      "backdrop-blur-[8px]",
      "animate-[fadeIn_0.15s_ease]",
    ]);

    const card = overlay.firstElementChild as HTMLElement;
    // The shell is presentational (parity with legacy `.modal`, which has no
    // role); a11y semantics are the consumer's and reach the card via rest.
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-label")).toBe("Example dialog");
    expectAll(card, [
      "w-full",
      "bg-bg-surface",
      "border",
      "border-border-default",
      "rounded-lg",
      "p-xl",
      "max-w-[480px]",
      "animate-[slideUp_0.2s_ease]",
    ]);
    expect(card.textContent).toBe("body");
  });

  it("confirm size narrows the card; overlayProps land on the overlay; layoutClassName on the card", () => {
    const overlay = root(
      <ModalShell
        size="confirm"
        overlayProps={{ "aria-hidden": true }}
        layoutClassName="max-w-[520px]"
      >
        x
      </ModalShell>,
    );
    expect(overlay.getAttribute("aria-hidden")).toBe("true");
    const card = overlay.firstElementChild as HTMLElement;
    expectAll(card, ["max-w-[400px]"]);
    expect(card.className.trim().endsWith("max-w-[520px]")).toBe(true);
  });

  it("ModalTitle is an h2 with display font; ModalActions right-aligns", () => {
    const title = root(<ModalTitle>Delete session?</ModalTitle>);
    expect(title.tagName).toBe("H2");
    expectAll(title, ["font-display", "font-bold", "text-[1.2rem]", "mb-lg"]);
    expectAll(root(<ModalActions />), ["flex", "justify-end", "gap-sm"]);
  });
});
