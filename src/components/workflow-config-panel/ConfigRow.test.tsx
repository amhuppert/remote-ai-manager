// @vitest-environment jsdom
/**
 * Row primitives: the drill row, the control row, and the provenance chrome
 * both wear — tier chip when inherited, cyan set-here edge and a
 * granularity-specific reset when the value is the reader's own (README §7).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfigControlRow, ConfigDrillRow, ConfigRowGroup } from "./ConfigRow";
import type { ConfigRowProvenance } from "./row-provenance";
import { chipPart, dotPart, textPart } from "./value-parts";

afterEach(cleanup);

const INHERITED_GLOBAL: ConfigRowProvenance = {
  sourceTier: "global",
  scopeTier: "context",
  granularity: "block",
};

const INHERITED_WORKFLOW: ConfigRowProvenance = {
  sourceTier: "workflow",
  scopeTier: "context",
  granularity: "field",
};

const SET_HERE_ROLE: ConfigRowProvenance = {
  sourceTier: "context",
  scopeTier: "context",
  granularity: "role",
};

describe("ConfigDrillRow", () => {
  it("opens its screen and renders the summary value parts", () => {
    const onOpen = vi.fn();
    render(
      <ConfigDrillRow
        screenId="implementer"
        label="Implementer"
        parts={[chipPart("claude"), textPart("high")]}
        provenance={INHERITED_GLOBAL}
        onOpen={onOpen}
      />,
    );

    const row = screen.getByRole("button", { name: /implementer/i });
    expect(row).toHaveTextContent("claude");
    expect(row).toHaveTextContent("high");

    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("wears the inherited tier chip and its tooltip", () => {
    render(
      <ConfigDrillRow
        screenId="implementer"
        label="Implementer"
        parts={[]}
        provenance={INHERITED_GLOBAL}
        onOpen={vi.fn()}
      />,
    );

    const chip = screen.getByTestId("config-tier-chip");
    expect(chip).toHaveTextContent("G");
    expect(chip).toHaveAttribute(
      "title",
      "Inherited from global defaults — this block is not set on the context",
    );
    expect(screen.getByTestId("config-row-implementer")).not.toHaveAttribute(
      "data-set-here",
      "true",
    );
  });

  it("drops the tier chip and takes the set-here edge when the group is overridden", () => {
    render(
      <ConfigDrillRow
        screenId="implementer"
        label="Implementer"
        parts={[dotPart("1 block set on this context")]}
        provenance={{ ...INHERITED_GLOBAL, setHere: true }}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("config-tier-chip")).not.toBeInTheDocument();
    expect(screen.getByTestId("config-row-implementer")).toHaveAttribute(
      "data-set-here",
      "true",
    );
  });

  it("carries the navigation trigger id so focus returns to it", () => {
    render(
      <ConfigDrillRow
        screenId="implementer"
        label="Implementer"
        parts={[]}
        provenance={INHERITED_GLOBAL}
        onOpen={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /implementer/i }),
    ).toHaveAttribute("id", "cfgnav-implementer");
  });
});

describe("ConfigControlRow", () => {
  it("renders its control, its hint and the inherited tier chip", () => {
    render(
      <ConfigControlRow
        rowId="rounds"
        label="Negotiation rounds"
        hint="How many exchanges the two agents get."
        provenance={INHERITED_WORKFLOW}
        control={<input aria-label="Negotiation rounds" defaultValue="3" />}
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Negotiation rounds" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("How many exchanges the two agents get."),
    ).toBeInTheDocument();
    const chip = screen.getByTestId("config-tier-chip");
    expect(chip).toHaveTextContent("W");
    expect(chip).toHaveAttribute(
      "title",
      "Inherited from this workflow — this field is not set on the context",
    );
    expect(
      screen.queryByRole("button", { name: /reset this/i }),
    ).not.toBeInTheDocument();
  });

  it("offers a granularity-named reset for a value set at the current tier", () => {
    const onReset = vi.fn();
    render(
      <ConfigControlRow
        rowId="agentval-implementer"
        label="Implementer"
        provenance={SET_HERE_ROLE}
        onReset={onReset}
        control={<input aria-label="Implementer" defaultValue="all" />}
      />,
    );

    expect(screen.queryByTestId("config-tier-chip")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("config-row-agentval-implementer"),
    ).toHaveAttribute("data-set-here", "true");

    const reset = screen.getByRole("button", {
      name: "Reset this role to inherit",
    });
    expect(reset).toHaveAttribute("title", "Reset this role to inherit");
    fireEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("withholds the reset button while the row is read-only", () => {
    render(
      <ConfigControlRow
        rowId="agentval-implementer"
        label="Implementer"
        provenance={SET_HERE_ROLE}
        onReset={vi.fn()}
        disabled
        control={<input aria-label="Implementer" defaultValue="all" />}
      />,
    );

    expect(
      screen.queryByRole("button", { name: /reset this/i }),
    ).not.toBeInTheDocument();
  });

  it("renders read-only value parts and full-width content below the hint", () => {
    render(
      <ConfigControlRow
        rowId="upstream"
        label="Upstream inputs"
        hint="Read-only — produced by the contexts this one depends on."
        parts={[textPart("2"), textPart("fields", "dim")]}
      >
        <p>wide content</p>
      </ConfigControlRow>,
    );

    const row = screen.getByTestId("config-row-upstream");
    expect(row).toHaveTextContent("2");
    expect(row).toHaveTextContent("fields");
    expect(screen.getByText("wide content")).toBeInTheDocument();
  });
});

describe("ConfigRowGroup", () => {
  it("labels a section and groups the rows beneath it", () => {
    render(
      <ConfigRowGroup label="Identity">
        <ConfigControlRow
          rowId="title"
          label="Title"
          control={<input aria-label="Title" defaultValue="Checkout" />}
        />
      </ConfigRowGroup>,
    );

    expect(screen.getByText("Identity")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Title" })).toBeInTheDocument();
  });
});
