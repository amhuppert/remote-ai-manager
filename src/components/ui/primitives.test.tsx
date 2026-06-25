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
import { IconButton } from "./IconButton";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDesc,
} from "./EmptyState";
import {
  FormGroup,
  FormLabel,
  FormInput,
  FormHint,
  FormError,
} from "./FormField";

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
    "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    "focus-visible:outline-offset-2",
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

  it("touch adds the mobile-spine 44px touch sizing (off by default)", () => {
    const plain = root(<Button size="sm">x</Button>);
    expect(plain.className).not.toContain("max-768:min-h-[44px]");
    expect(plain.className).not.toContain("max-768:px-[16px]");

    const el = root(
      <Button size="sm" touch>
        x
      </Button>,
    );
    expectAll(el, ["max-768:min-h-[44px]", "max-768:px-[16px]"]);
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

  it("subtle renders the neutral muted palette (no opacity fade) and layoutClassName is appended last", () => {
    const el = root(
      <Badge status="running" subtle layoutClassName="ml-1">
        x
      </Badge>,
    );
    expectAll(el, ["bg-bg-raised", "text-text-secondary"]);
    expect(el.className).not.toContain("opacity-50");
    // subtle replaces the variant appearance, it does not layer over it.
    expect(el.className).not.toContain("bg-cyan-glow");
    expect(el.className).not.toContain("text-cyan");
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

  it("fill adds the mobile-spine centre + 36px touch sizing (off by default)", () => {
    const plain = root(<Tab>One</Tab>);
    expect(plain.className).not.toContain("max-768:justify-center");
    expect(plain.className).not.toContain("max-768:min-h-[36px]");

    const filled = root(<Tab fill>One</Tab>);
    expectAll(filled, ["max-768:justify-center", "max-768:min-h-[36px]"]);
  });

  it("TabCount inherits the tab colour (no opacity fade); data-active reflects state", () => {
    const off = root(<TabCount>3</TabCount>);
    expect(off.getAttribute("data-active")).toBe("false");
    expectAll(off, [
      "font-mono",
      "text-[0.7rem]",
      "font-medium",
      "px-[4px]",
      "rounded-full",
    ]);
    expect(off.className).not.toContain("opacity-[0.85]");
    expect(off.className).not.toContain("opacity-100");

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

describe("IconButton", () => {
  const baseSet = [
    "inline-flex",
    "items-center",
    "cursor-pointer",
    "transition-all",
    "duration-150",
    "ease-[ease]",
    "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    "focus-visible:outline-offset-2",
  ];

  it("square md is the default variant/size (.btn-icon-only parity)", () => {
    const el = root(<IconButton aria-label="settings" />);
    expect(el.tagName).toBe("BUTTON");
    expect(el.getAttribute("data-pressed")).toBe("false");
    expectAll(el, [
      ...baseSet,
      "relative",
      "justify-center",
      "size-[30px]",
      "[&>svg]:size-[18px]",
      "rounded-sm",
      "border",
      "border-solid",
      "border-border-default",
      "bg-transparent",
      "text-[0.85rem]",
      "text-text-secondary",
      "hover:bg-bg-hover",
      "hover:text-text-primary",
      "hover:border-border-strong",
    ]);
  });

  it("square enlarges every default icon button to a 44px/1rem touch target on mobile (globals.css max-768 rules)", () => {
    const el = root(<IconButton aria-label="settings" />);
    expectAll(el, [
      "max-768:w-[44px]",
      "max-768:h-[44px]",
      "max-768:min-w-[44px]",
      "max-768:min-h-[44px]",
      "max-768:text-[1rem]",
    ]);
  });

  it("square touch enlarges the box and the glyph", () => {
    const el = root(<IconButton size="touch" aria-label="x" />);
    expectAll(el, ["size-[44px]", "[&>svg]:size-[26px]"]);
    expect(el.className).not.toContain("size-[30px]");
  });

  it("square danger recolours only the hover state", () => {
    const el = root(<IconButton tone="danger" aria-label="delete" />);
    expectAll(el, [
      "text-text-secondary",
      "hover:bg-red-glow",
      "hover:text-red",
      "hover:border-red-dim",
    ]);
    expect(el.className).not.toContain("hover:bg-bg-hover");
  });

  it("pill maps to the .cc-ibtn icon+label recipe with rest-state colours", () => {
    const el = root(<IconButton variant="pill">label</IconButton>);
    expectAll(el, [
      "gap-[6px]",
      "h-[30px]",
      "px-[10px]",
      "rounded-md",
      "border",
      "border-solid",
      "border-border-subtle",
      "text-text-secondary",
      "[&_svg]:text-text-tertiary",
      "data-[pressed=false]:hover:bg-bg-hover",
      "data-[pressed=false]:hover:text-text-primary",
    ]);
    expect(el.className).not.toContain("size-[30px]");
  });

  it("pill pressed adds the cyan active toggle (legacy .cc-ibtn.active)", () => {
    const el = root(
      <IconButton variant="pill" pressed>
        label
      </IconButton>,
    );
    expect(el.getAttribute("data-pressed")).toBe("true");
    expectAll(el, [
      "data-[pressed=true]:text-cyan",
      "data-[pressed=true]:bg-cyan-glow",
      "data-[pressed=true]:border-cyan-glow-strong",
      "data-[pressed=true]:[&_svg]:text-cyan",
    ]);
  });

  it("ghost replicates the pin-toggle pilot recipe (borderless, amber glow)", () => {
    const el = root(
      <IconButton variant="ghost" aria-label="pin">
        ☆
      </IconButton>,
    );
    expectAll(el, [
      "size-[24px]",
      "shrink-0",
      "border-0",
      "bg-transparent",
      "text-text-tertiary",
      "max-768:min-h-[44px]",
      "max-768:min-w-[44px]",
      "hover:text-amber",
      "hover:[filter:drop-shadow(0_0_3px_var(--cc-amber-a40))]",
    ]);
  });

  it("ghost pressed swaps to the pinned amber glow", () => {
    const el = root(
      <IconButton variant="ghost" pressed aria-label="unpin">
        ★
      </IconButton>,
    );
    expect(el.getAttribute("data-pressed")).toBe("true");
    expectAll(el, [
      "data-[pressed=true]:text-amber",
      "data-[pressed=true]:[filter:drop-shadow(0_0_4px_var(--cc-amber-a50))]",
      "data-[pressed=true]:hover:text-amber-dim",
    ]);
  });

  it("appends layoutClassName last (layout-only, after appearance)", () => {
    const el = root(
      <IconButton variant="pill" layoutClassName="ml-auto">
        x
      </IconButton>,
    );
    expect(el.className.trim().endsWith("ml-auto")).toBe(true);
  });

  it("forwards native button attributes through the Omit", () => {
    const el = root(
      <IconButton type="submit" disabled aria-label="go">
        <span>★</span>
      </IconButton>,
    );
    expect(el.getAttribute("type")).toBe("submit");
    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.getAttribute("aria-label")).toBe("go");
  });
});

describe("EmptyState", () => {
  it("container is a centred column with the .empty-state padding", () => {
    const el = root(<EmptyState>x</EmptyState>);
    expectAll(el, [
      "flex",
      "flex-col",
      "items-center",
      "justify-center",
      "px-xl",
      "py-3xl",
      "text-center",
    ]);
  });

  it("icon, title, and desc carry their parity recipes", () => {
    expectAll(root(<EmptyStateIcon>📭</EmptyStateIcon>), [
      "text-[2.5rem]",
      "mb-lg",
      "opacity-30",
    ]);
    expectAll(root(<EmptyStateTitle>none</EmptyStateTitle>), [
      "font-display",
      "font-bold",
      "text-[1.1rem]",
      "text-text-secondary",
      "mb-sm",
    ]);
    expectAll(root(<EmptyStateDesc>desc</EmptyStateDesc>), [
      "font-mono",
      "text-[0.78rem]",
      "text-text-tertiary",
      "max-w-[320px]",
    ]);
  });

  it("appends layoutClassName last", () => {
    const el = root(<EmptyState layoutClassName="mt-xl">x</EmptyState>);
    expect(el.className.trim().endsWith("mt-xl")).toBe(true);
  });
});

describe("FormField", () => {
  it("input is the merged effective .form-input recipe", () => {
    const el = root(<FormInput aria-label="name" />);
    expect(el.tagName).toBe("INPUT");
    expectAll(el, [
      "w-full",
      "px-[12px]",
      "py-[9px]",
      "bg-bg-base",
      "border",
      "border-solid",
      "border-border-default",
      "rounded-md",
      "text-text-primary",
      "font-mono",
      "text-[0.82rem]",
      "outline-0",
      "placeholder:text-text-tertiary",
      "hover:border-border-strong",
      "focus:border-cyan",
      "focus:shadow-[0_0_0_3px_var(--cyan-glow)]",
    ]);
  });

  it("label is an uppercase mono block; group/hint/error carry their recipes", () => {
    const label = root(<FormLabel htmlFor="n">Name</FormLabel>);
    expect(label.tagName).toBe("LABEL");
    expect(label.getAttribute("for")).toBe("n");
    expectAll(label, [
      "block",
      "font-mono",
      "text-[0.72rem]",
      "font-semibold",
      "uppercase",
      "tracking-[0.08em]",
      "text-text-secondary",
      "mb-sm",
    ]);
    expectAll(root(<FormGroup>x</FormGroup>), ["mb-lg"]);
    expectAll(root(<FormHint>h</FormHint>), [
      "font-mono",
      "text-[0.7rem]",
      "text-text-tertiary",
      "mt-xs",
    ]);
    expectAll(root(<FormError>e</FormError>), [
      "font-mono",
      "text-[0.72rem]",
      "text-red",
      "mt-xs",
    ]);
  });

  it("input appends layoutClassName last (e.g. max-w from the parent)", () => {
    const el = root(
      <FormInput aria-label="n" layoutClassName="max-w-[240px]" />,
    );
    expect(el.className.trim().endsWith("max-w-[240px]")).toBe(true);
  });
});
