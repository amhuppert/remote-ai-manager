// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Progress } from "./Progress";

afterEach(cleanup);

// Radix drives the `progressbar` role + aria-value* wiring; these tests pin the
// CC class contract and the semantics the wrapper guarantees. jest-dom matchers
// are avoided (a known matcher-registration flake under the parallel runner);
// plain attribute/class assertions are used instead.
describe("Progress", () => {
  it("exposes progressbar semantics with aria-value* for a determinate value", () => {
    render(<Progress value={42} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("42");
    expect(bar.getAttribute("aria-valuemin")).toBe("0");
    expect(bar.getAttribute("aria-valuemax")).toBe("100");
  });

  it("honours a custom max", () => {
    render(<Progress value={3} max={5} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("3");
    expect(bar.getAttribute("aria-valuemax")).toBe("5");
  });

  it("omits aria-valuenow when indeterminate (value null)", () => {
    render(<Progress value={null} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBeNull();
    expect(bar.getAttribute("data-state")).toBe("indeterminate");
  });

  it("reflects the percentage on the indicator width and clamps out-of-range", () => {
    const { rerender, container } = render(<Progress value={42} />);
    const indicator = () =>
      container.querySelector<HTMLElement>("[data-state] > *");
    expect(indicator()?.style.width).toBe("42%");

    rerender(<Progress value={150} />);
    expect(indicator()?.style.width).toBe("100%");

    rerender(<Progress value={-10} />);
    expect(indicator()?.style.width).toBe("0%");
  });

  it("renders the CC track recipe and maps tone to the indicator fill", () => {
    const { rerender, container } = render(<Progress value={50} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.className).toContain("bg-bg-base");
    expect(bar.className).toContain("overflow-hidden");

    const indicator = () =>
      container.querySelector<HTMLElement>("[data-state] > *");
    // default tone = accent (cyan)
    expect(indicator()?.className).toContain("bg-cyan");

    rerender(<Progress value={50} tone="warning" />);
    expect(indicator()?.className).toContain("bg-amber");

    rerender(<Progress value={50} tone="danger" />);
    expect(indicator()?.className).toContain("bg-red");
  });

  it("appends layoutClassName for external geometry", () => {
    render(<Progress value={10} layoutClassName="w-[60px]" />);
    const bar = screen.getByRole("progressbar");
    expect(bar.className).toContain("w-[60px]");
  });
});
