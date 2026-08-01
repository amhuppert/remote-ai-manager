// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import { JsonTree } from "./JsonTree";

// Radix Collapsible measures its region via ResizeObserver (polyfilled in
// vitest.jsdom.setup) and may capture the pointer; stub what jsdom omits.
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const OUTPUT = {
  verdict: "flaky",
  confidence: 0.82,
  retriable: true,
  evidence: { runId: "9f2c41", attempts: 3 },
  blockers: ["retry storm", "missing teardown"],
  owner: null,
};

/** The row `<button>` that folds a branch, addressed by its visible key text. */
function toggleFor(name: RegExp): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("JsonTree — rendering", () => {
  it("renders every key and scalar value of an expanded object", () => {
    render(<JsonTree value={OUTPUT} />);

    expect(screen.getByText('"verdict":')).toBeInTheDocument();
    expect(screen.getByText('"flaky"')).toBeInTheDocument();
    expect(screen.getByText("0.82")).toBeInTheDocument();
    expect(screen.getByText("true")).toBeInTheDocument();
    expect(screen.getByText("null")).toBeInTheDocument();
    // Nested branch children are visible because nothing is collapsed.
    expect(screen.getByText('"runId":')).toBeInTheDocument();
    expect(screen.getByText('"9f2c41"')).toBeInTheDocument();
  });

  it("applies the thin color mapping: keys secondary, strings primary, numbers amber, booleans cyan, punctuation tertiary", () => {
    const { container } = render(<JsonTree value={OUTPUT} />);

    const key = container.querySelector('[data-json-token="key"]');
    const string = container.querySelector('[data-json-token="string"]');
    const number = container.querySelector('[data-json-token="number"]');
    const boolean = container.querySelector('[data-json-token="boolean"]');
    const nullish = container.querySelector('[data-json-token="null"]');
    const punctuation = container.querySelector(
      '[data-json-token="punctuation"]',
    );

    expect(key?.className).toContain("text-text-secondary");
    expect(string?.className).toContain("text-text-primary");
    expect(number?.className).toContain("text-amber");
    expect(boolean?.className).toContain("text-cyan");
    expect(nullish?.className).toContain("text-text-tertiary");
    expect(punctuation?.className).toContain("text-text-tertiary");
  });

  it("renders array items without key labels and a scalar root without any branch", () => {
    const { container, rerender } = render(<JsonTree value={["a", "b"]} />);
    expect(screen.getByText('"a"')).toBeInTheDocument();
    expect(screen.getByText('"b"')).toBeInTheDocument();
    expect(container.querySelector('[data-json-token="key"]')).toBeNull();

    rerender(<JsonTree value="just a string" />);
    expect(screen.getByText('"just a string"')).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("renders empty containers inline, with no toggle to fold", () => {
    render(<JsonTree value={{ items: [], meta: {} }} />);

    expect(screen.getByText("[]")).toBeInTheDocument();
    expect(screen.getByText("{}")).toBeInTheDocument();
    // Only the root object is foldable.
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });
});

describe("JsonTree — lossless encoding", () => {
  it("escapes strings with JSON semantics instead of bare-wrapping them in quotes", () => {
    render(
      <JsonTree
        value={{
          quoted: 'he said "hi"',
          backslash: "a\\b",
          control: "line1\nline2\tend",
        }}
      />,
    );

    expect(screen.getByText('"he said \\"hi\\""')).toBeInTheDocument();
    expect(screen.getByText('"a\\\\b"')).toBeInTheDocument();
    // Control whitespace renders as escapes, never as a literal line break.
    expect(screen.getByText('"line1\\nline2\\tend"')).toBeInTheDocument();
  });

  it("escapes property names too", () => {
    const { container } = render(
      <JsonTree value={{ 'we"ird': 1, "back\\slash": 2 }} />,
    );
    const keys = Array.from(
      container.querySelectorAll('[data-json-token="key"]'),
    ).map((el) => el.textContent);

    expect(keys).toEqual(['"we\\"ird":', '"back\\\\slash":']);
  });

  it("keeps distinct values distinguishable: significant whitespace is preserved, not collapsed", () => {
    const { container } = render(
      <JsonTree value={{ one: "a b", two: "a  b", three: " padded " }} />,
    );
    const values = Array.from(
      container.querySelectorAll('[data-json-token="string"]'),
    );

    expect(values.map((el) => el.textContent)).toEqual([
      '"a b"',
      '"a  b"',
      '" padded "',
    ]);
    // textContent keeps the runs regardless of CSS, so the rendered-distinctness
    // guarantee is the white-space rule: without it the browser collapses them.
    for (const el of values) {
      expect(el.className).toContain("whitespace-pre-wrap");
    }
    expect(
      container.querySelector('[data-json-token="key"]')?.className,
    ).toContain("whitespace-pre-wrap");
  });

  it("round-trips a captured payload: every rendered leaf parses back to its source value", () => {
    const payload = {
      quoted: 'say "what"',
      path: "C:\\tmp\\x",
      spaced: "a  b",
      unicode: "e\u0301 — ok",
    };
    const { container } = render(<JsonTree value={payload} />);
    const rendered = Array.from(
      container.querySelectorAll('[data-json-token="string"]'),
    ).map((el) => JSON.parse(el.textContent ?? ""));

    expect(rendered).toEqual(Object.values(payload));
  });
});

describe("JsonTree — folding", () => {
  it("gives every branch an accessible toggle that reports its expanded state", () => {
    render(<JsonTree value={OUTPUT} />);

    const branch = toggleFor(/"evidence"/);
    expect(branch).toHaveAttribute("aria-expanded", "true");
    // The toggle names the branch for assistive tech, not just its punctuation.
    expect(branch).toHaveAccessibleName(/2 entries/);
  });

  it("folds a branch on click: children leave the tree and a summary count replaces them", () => {
    render(<JsonTree value={OUTPUT} />);

    fireEvent.click(toggleFor(/"evidence"/));

    expect(toggleFor(/"evidence"/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText('"runId":')).not.toBeInTheDocument();
    expect(screen.getByText("{ … 2 }")).toBeInTheDocument();
    // Unfolding restores them.
    fireEvent.click(toggleFor(/"evidence"/));
    expect(screen.getByText('"runId":')).toBeInTheDocument();
  });

  // Enter/Space activation is the platform's, not ours: jsdom does not
  // synthesize a click from key events, so the contract we can assert here is
  // that the toggle IS a native focusable button. The real key walkthrough runs
  // live in Storybook (ui-primitive Phase 6).
  it("puts every toggle in the tab order as a native button", () => {
    render(<JsonTree value={OUTPUT} />);
    const branch = toggleFor(/"evidence"/);

    expect(branch.tagName).toBe("BUTTON");
    expect(branch).toHaveAttribute("type", "button");
    expect(branch).not.toHaveAttribute("tabindex", "-1");
    branch.focus();
    expect(branch).toHaveFocus();
  });

  it("collapses branches at or below defaultCollapsedDepth on first paint", () => {
    render(<JsonTree value={OUTPUT} defaultCollapsedDepth={1} />);

    // Root (depth 0) stays open; its object/array children (depth 1) start folded.
    expect(screen.getByText('"verdict":')).toBeInTheDocument();
    expect(toggleFor(/"evidence"/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText('"runId":')).not.toBeInTheDocument();
    expect(toggleFor(/"blockers"/)).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("[ … 2 ]")).toBeInTheDocument();
  });

  it("defaultCollapsedDepth=0 folds the root itself", () => {
    render(<JsonTree value={OUTPUT} defaultCollapsedDepth={0} />);

    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByText("{ … 6 }")).toBeInTheDocument();
  });

  it("omitting defaultCollapsedDepth expands every branch", () => {
    render(<JsonTree value={OUTPUT} />);

    // Root + evidence + blockers.
    const toggles = screen.getAllByRole("button");
    expect(toggles).toHaveLength(3);
    for (const toggle of toggles) {
      expect(toggle).toHaveAttribute("aria-expanded", "true");
    }
  });

  it("keeps the reader's folds when the prop changes: defaultCollapsedDepth is initial state only", () => {
    const { rerender } = render(
      <JsonTree value={OUTPUT} defaultCollapsedDepth={0} />,
    );
    expect(toggleFor(/6 entries/)).toHaveAttribute("aria-expanded", "false");

    rerender(<JsonTree value={OUTPUT} defaultCollapsedDepth={5} />);

    expect(toggleFor(/6 entries/)).toHaveAttribute("aria-expanded", "false");
  });
});

describe("JsonTree — copy affordance", () => {
  function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return { writeText };
  }

  it("is absent unless requested", () => {
    render(<JsonTree value={OUTPUT} />);
    expect(screen.queryByRole("button", { name: /copy/i })).toBeNull();
  });

  // A floating action pinned over the tree would sit on top of the root row,
  // which is itself a fold target — overlapping hit areas (2.5.8) and a focus
  // ring partly behind the button (2.4.11). It gets its own row instead.
  it("takes its own row rather than floating over the first fold target", () => {
    stubClipboard();
    const { container } = render(<JsonTree value={OUTPUT} copyable />);
    const copy = screen.getByRole("button", { name: /copy json/i });

    expect(copy.closest(".absolute")).toBeNull();
    const rootToggle = toggleFor(/6 entries/);
    expect(copy.compareDocumentPosition(rootToggle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(container.firstElementChild?.className).not.toContain("relative");
  });

  it("copies the pretty-printed JSON and confirms, then reverts", async () => {
    vi.useFakeTimers();
    try {
      const { writeText } = stubClipboard();
      render(<JsonTree value={OUTPUT} copyable />);

      const copy = screen.getByRole("button", { name: /copy json/i });
      fireEvent.click(copy);
      await act(async () => {});

      expect(writeText).toHaveBeenCalledWith(JSON.stringify(OUTPUT, null, 2));
      expect(
        screen.getByRole("button", { name: /copied/i }),
      ).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(
        screen.getByRole("button", { name: /copy json/i }),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("JsonTree — class contract", () => {
  it("branch toggles carry the canonical cyan focus-visible outline and a comfortable target height", () => {
    render(<JsonTree value={OUTPUT} />);
    const branch = toggleFor(/"evidence"/);

    expect(branch.className).toContain(
      "focus-visible:[outline:2px_solid_var(--color-cyan)]",
    );
    expect(branch.className).toContain("min-h-[24px]");
  });

  // On the handoff's bg-base surface, bg-hover (#1c2841) drops text-secondary to
  // 4.14:1 and text-tertiary to 3.92:1 — both under AA 4.5:1 at 0.72rem. Hover
  // therefore moves ONE elevation step to bg-surface (5.01:1 / 4.74:1), which is
  // also the design system's "hover moves up one level" rule.
  it("hovers to a contrast-safe surface, never the AA-failing bg-hover", () => {
    render(<JsonTree value={OUTPUT} />);
    const branch = toggleFor(/"evidence"/);

    expect(branch.className).toContain("hover:bg-bg-surface");
    expect(branch.className).not.toContain("hover:bg-bg-hover");
  });

  it("appends layoutClassName last so it can never override appearance", () => {
    const { container } = render(
      <JsonTree value={OUTPUT} layoutClassName="max-w-[420px]" />,
    );
    const root = container.firstElementChild;

    expect(root?.className).toContain("font-mono");
    expect(root?.className.trim().split(/\s+/).at(-1)).toBe("max-w-[420px]");
  });
});
