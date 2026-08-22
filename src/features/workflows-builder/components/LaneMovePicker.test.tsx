// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { createWorkflowDefinition } from "@/lib/workflow-graph/test-fixtures";
import LaneMovePicker from "./LaneMovePicker";
import type { LaneDragDrop } from "./lane-drag";

/** The same two-lane graph the drag tests use, so both routes are judged alike. */
function definition(): WorkflowSemanticDefinition {
  return {
    ...createWorkflowDefinition(),
    executionContexts: [
      {
        id: "ctx_checkout",
        title: "Implement checkout",
        acceptanceCriteria: "Checkout works",
        placement: {
          lane: "delivery",
          mode: "owned",
          ownedPaths: ["src/checkout"],
        },
      },
      {
        id: "ctx_notes",
        title: "Release notes",
        acceptanceCriteria: "Notes are written",
        placement: { lane: "session", mode: "readOnly" },
        outputSchema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
        },
      },
    ],
    tasks: [],
    edges: [],
  };
}

const LANES = ["delivery", "session", "rollback"] as const;

function renderPicker(
  contextId: string,
  onResolve: (drop: LaneDragDrop) => void = () => {},
  onClose: () => void = () => {},
) {
  return render(
    <LaneMovePicker
      definition={definition()}
      contextId={contextId}
      laneNames={LANES}
      onResolve={onResolve}
      onClose={onClose}
    />,
  );
}

function laneOption(laneName: string): HTMLElement {
  const option = document.querySelector<HTMLElement>(
    `[data-lane-option="${laneName}"]`,
  );
  expect(option).not.toBeNull();
  return option as HTMLElement;
}

describe("LaneMovePicker", () => {
  it("names the context being moved and offers every lane on the canvas", () => {
    renderPicker("ctx_notes");

    expect(screen.getByRole("dialog")).toHaveTextContent("Release notes");
    for (const lane of LANES) {
      expect(laneOption(lane)).toBeInTheDocument();
    }
  });

  // A touch surface has no Escape key, so leaving without choosing has to be a
  // control rather than a tap on the scrim.
  it("leaves without re-placing anything", async () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    renderPicker("ctx_checkout", onResolve, onClose);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalled();
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("previews each lane with the drag's own preview label", () => {
    renderPicker("ctx_checkout");

    expect(laneOption("rollback")).toHaveTextContent(
      "Re-place → lane: rollback · grade: owned (src/checkout) · unchanged",
    );
  });

  // The desktop hover pill already says accepted-or-refused before the pointer
  // is released; a picker row is where a phone reads the same thing.
  it("marks a lane the placement check would refuse", () => {
    renderPicker("ctx_checkout");

    expect(laneOption("session")).toHaveAttribute(
      "data-drop-outcome",
      "refused",
    );
    expect(laneOption("rollback")).toHaveAttribute(
      "data-drop-outcome",
      "accepted",
    );
  });

  it("holds the lane the context already declares out of the choices", () => {
    renderPicker("ctx_checkout");

    const current = laneOption("delivery");
    expect(current).toBeDisabled();
    expect(current).toHaveTextContent("current lane");
  });

  it("resolves a chosen lane through the drag's drop model", async () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    renderPicker("ctx_checkout", onResolve, onClose);

    await userEvent.click(laneOption("rollback"));

    expect(onResolve).toHaveBeenCalledTimes(1);
    const drop = onResolve.mock.calls[0]?.[0] as LaneDragDrop;
    expect(drop).toMatchObject({ kind: "replace", targetLane: "rollback" });
    expect(onClose).toHaveBeenCalled();
  });

  // A refusal has to be reachable: disabling the row would leave the author
  // with a lane they cannot use and no sentence saying why.
  it("hands a refused choice back so the canvas can state reason and remedy", async () => {
    const onResolve = vi.fn();
    renderPicker("ctx_checkout", onResolve);

    await userEvent.click(laneOption("session"));

    const drop = onResolve.mock.calls[0]?.[0] as LaneDragDrop;
    expect(drop.kind).toBe("refused");
    if (drop.kind !== "refused") throw new Error("expected a refusal");
    expect(drop.reason).toContain("admits only read-only contexts");
    expect(drop.remedy).toContain("read-only");
  });
});

// README §2.2 — a lane the picker invents is named by the SAME grammar and the
// same reserved-name rules an ephemeral band on the canvas is named by.
describe("LaneMovePicker — new lane", () => {
  async function typeNewLane(name: string) {
    const field = screen.getByLabelText("New lane name");
    await userEvent.clear(field);
    if (name.length > 0) await userEvent.type(field, name);
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Move to the new lane",
      }),
    );
  }

  it("offers an unused default name", () => {
    renderPicker("ctx_checkout");

    expect(screen.getByLabelText("New lane name")).toHaveValue("new-lane");
  });

  it("places the context on a legal new lane", async () => {
    const onResolve = vi.fn();
    renderPicker("ctx_checkout", onResolve);

    await typeNewLane("rollback-2");

    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0]).toMatchObject({
      kind: "replace",
      targetLane: "rollback-2",
    });
  });

  it("refuses a reserved name in place, writing nothing", async () => {
    const onResolve = vi.fn();
    const onClose = vi.fn();
    renderPicker("ctx_checkout", onResolve, onClose);

    await typeNewLane("session");

    expect(onResolve).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "is the session worktree",
    );
  });

  it("refuses a name the lane grammar rejects", async () => {
    const onResolve = vi.fn();
    renderPicker("ctx_checkout", onResolve);

    await typeNewLane("bad lane/name");

    expect(onResolve).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent(
      "branch and worktree path segments",
    );
  });
});
