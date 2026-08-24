// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AgentBackendId } from "@/lib/shared/schemas";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { FormError, FormHint, FormInput, FormLabel } from "./FormField";
import { IconButton } from "./IconButton";
import { Spinner } from "./Spinner";
import { StatusChip, type StatusChipTone } from "./StatusChip";
import { Tab, TabCount } from "./Tabs";

const CHIP_TONES: StatusChipTone[] = [
  "neutral",
  "cyan",
  "amber",
  "green",
  "red",
  "violet",
];

describe("Spinner", () => {
  it("is hidden from assistive technology", () => {
    const { container } = render(<Spinner />);

    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });
});

describe("Button", () => {
  it("provides an always-on 44px touch-target size", () => {
    const { getByRole } = render(<Button size="touch">Reply</Button>);
    const button = getByRole("button", { name: "Reply" });

    expect(button).toHaveClass("min-h-[44px]", "min-w-[44px]");
    expect(button.className).not.toContain("max-768:min-h-[44px]");
  });

  it("exposes its loading state without replacing the label", () => {
    const { getByRole, container } = render(<Button loading>Save</Button>);
    const button = getByRole("button", { name: "Save" });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("forwards native attributes and click behavior", () => {
    let clicks = 0;
    const { getByRole } = render(
      <Button type="submit" aria-label="Go" onClick={() => clicks++}>
        Submit
      </Button>,
    );
    const button = getByRole("button", { name: "Go" });

    button.click();

    expect(button).toHaveAttribute("type", "submit");
    expect(clicks).toBe(1);
  });
});

describe("Badge", () => {
  it("exposes the selected semantic tier value", () => {
    const { rerender, container } = render(<Badge status="running">Run</Badge>);

    expect(container.firstElementChild).toHaveAttribute(
      "data-status",
      "running",
    );

    rerender(
      <Badge tier="type" kind="bug">
        Bug
      </Badge>,
    );
    expect(container.firstElementChild).toHaveAttribute("data-type", "bug");

    rerender(
      <Badge tier="count" active>
        3
      </Badge>,
    );
    expect(container.firstElementChild).toHaveAttribute("data-active", "true");
  });

  it("flags backend identifiers outside the catalog", () => {
    const { container } = render(
      <Badge backend={"mystery" as AgentBackendId}>mystery</Badge>,
    );

    expect(container.firstElementChild).toHaveAttribute(
      "data-backend-unknown",
      "true",
    );
  });

  it("does not leak variant props onto the DOM node", () => {
    const { container } = render(
      <Badge tier="status" status="merged" id="result" />,
    );
    const badge = container.firstElementChild;

    expect(badge).not.toHaveAttribute("tier");
    expect(badge).not.toHaveAttribute("status");
    expect(badge).toHaveAttribute("id", "result");
  });
});

describe("StatusChip", () => {
  it("renders its semantic state and leading icon", () => {
    const { container, getByTestId } = render(
      <StatusChip
        tone="cyan"
        appearance="flat"
        icon={<i data-testid="chip-icon" />}
      >
        Compacting
      </StatusChip>,
    );
    const chip = container.firstElementChild;

    expect(chip).toHaveAttribute("data-tone", "cyan");
    expect(chip).toHaveAttribute("data-appearance", "flat");
    expect(getByTestId("chip-icon")).toBe(chip?.firstElementChild);
    expect(chip).toHaveTextContent("Compacting");
  });

  it("renders an interactive chip as a native button", () => {
    let clicks = 0;
    const { getByRole } = render(
      <StatusChip as="button" aria-label="Open" onClick={() => clicks++}>
        Stale
      </StatusChip>,
    );
    const button = getByRole("button", { name: "Open" });

    button.click();

    expect(button).toHaveAttribute("type", "button");
    expect(clicks).toBe(1);
  });

  // Preflight is off, so a <button> that declares no background inherits the
  // UA `buttonface` fill — an opaque light pill on CC's dark chrome. Every tone
  // must therefore name its own background rather than leave it unset.
  it("gives every tone a background so an interactive chip never falls back to the UA button fill", () => {
    for (const tone of CHIP_TONES) {
      const { getByRole, unmount } = render(
        <StatusChip as="button" tone={tone} aria-label={tone}>
          Phase
        </StatusChip>,
      );

      expect(getByRole("button", { name: tone }).className).toMatch(
        /(?:^|\s)bg-\S/,
      );
      unmount();
    }
  });
});

describe("Tab and TabCount", () => {
  it("exposes active state without leaking it as an active attribute", () => {
    const { container } = render(
      <Tab active>
        Runs <TabCount active>3</TabCount>
      </Tab>,
    );
    const tab = container.firstElementChild;
    const count = tab?.firstElementChild;

    expect(tab).toHaveAttribute("data-active", "true");
    expect(tab).not.toHaveAttribute("active");
    expect(count).toHaveAttribute("data-active", "true");
  });
});

describe("IconButton", () => {
  it("forwards native attributes and exposes pressed state", () => {
    let clicks = 0;
    const { getByRole } = render(
      <IconButton
        type="submit"
        pressed
        aria-label="Pin"
        onClick={() => clicks++}
      />,
    );
    const button = getByRole("button", { name: "Pin" });

    button.click();

    expect(button).toHaveAttribute("type", "submit");
    expect(button).toHaveAttribute("data-pressed", "true");
    expect(clicks).toBe(1);
  });
});

describe("FormField", () => {
  it("styles a native file selector as a design-system button", () => {
    const { getByLabelText } = render(
      <FormInput type="file" aria-label="Context file" />,
    );

    expect(getByLabelText("Context file")).toHaveClass(
      "file:border-border-default",
      "file:bg-bg-surface",
      "file:text-text-primary",
      "hover:file:border-border-strong",
      "hover:file:bg-bg-raised",
    );
  });

  it("forwards native label, input, hint, and error semantics", () => {
    const { getByLabelText, getByRole, getByText } = render(
      <>
        <FormLabel htmlFor="name">Name</FormLabel>
        <FormInput
          id="name"
          name="name"
          required
          aria-describedby="name-hint name-error"
        />
        <FormHint id="name-hint">Use the project name</FormHint>
        <FormError id="name-error" role="alert">
          Name is required
        </FormError>
      </>,
    );

    expect(getByLabelText("Name")).toHaveAttribute("name", "name");
    expect(getByLabelText("Name")).toBeRequired();
    expect(getByText("Use the project name")).toHaveAttribute(
      "id",
      "name-hint",
    );
    expect(getByRole("alert")).toHaveTextContent("Name is required");
  });
});
