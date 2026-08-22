// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import EphemeralLaneBand from "./EphemeralLaneBand";

function renderBand(
  overrides: Partial<React.ComponentProps<typeof EphemeralLaneBand>> = {},
) {
  const props = {
    lane: { id: "e1", name: "new-lane" },
    box: { laneName: "new-lane", x: 10, y: 400, width: 900, height: 132 },
    taken: ["plan", "delivery"],
    onRename: vi.fn(),
    onMerge: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  } satisfies React.ComponentProps<typeof EphemeralLaneBand>;
  render(<EphemeralLaneBand {...props} />);
  return props;
}

async function retype(name: string) {
  const user = userEvent.setup();
  const input = screen.getByLabelText("Lane name");
  await user.clear(input);
  await user.type(input, `${name}{Enter}`);
  return user;
}

describe("EphemeralLaneBand", () => {
  it("says it holds nothing and has nothing to save", () => {
    renderBand();

    expect(screen.getByLabelText("Lane name")).toHaveValue("new-lane");
    expect(
      screen.getByText("0 members · nothing to save yet"),
    ).toBeInTheDocument();
  });

  it("commits a fresh legal name", async () => {
    const props = renderBand();

    await retype("rollback");

    expect(props.onRename).toHaveBeenCalledWith("e1", "rollback");
    expect(props.onMerge).not.toHaveBeenCalled();
  });

  it("commits on blur as well as Enter", async () => {
    const user = userEvent.setup();
    const props = renderBand();

    const input = screen.getByLabelText("Lane name");
    await user.clear(input);
    await user.type(input, "rollback");
    await user.tab();

    expect(props.onRename).toHaveBeenCalledWith("e1", "rollback");
  });

  // §2.2: an existing name means "use the existing lane", not a second band.
  it("merges into an existing lane instead of duplicating it", async () => {
    const props = renderBand();

    await retype("delivery");

    expect(props.onMerge).toHaveBeenCalledWith(
      "e1",
      'Naming it delivery means "use the existing lane" — the band merges with it rather than creating a duplicate.',
    );
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("refuses the reserved session lane and keeps the band", async () => {
    const props = renderBand();

    await retype("session");

    expect(props.onRename).not.toHaveBeenCalled();
    expect(props.onMerge).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /admits read-only contexts only/,
    );
  });

  it("refuses the engine's internal session id", async () => {
    const props = renderBand();

    await retype("__session__");

    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/internal id/);
  });

  it("refuses a name the lane grammar rejects", async () => {
    const props = renderBand();

    await retype("release/train");

    expect(props.onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      /branch and worktree path segments/,
    );
  });

  it("retires the refusal once a legal name is committed", async () => {
    renderBand();

    await retype("session");
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await retype("rollback");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("puts the committed name back on Escape", async () => {
    const user = userEvent.setup();
    const props = renderBand();

    const input = screen.getByLabelText("Lane name");
    await user.clear(input);
    await user.type(input, "rollback{Escape}");

    expect(input).toHaveValue("new-lane");
    expect(props.onRename).not.toHaveBeenCalled();
  });

  it("discards the band on request", async () => {
    const user = userEvent.setup();
    const props = renderBand();

    await user.click(screen.getByRole("button", { name: /remove lane/i }));

    expect(props.onRemove).toHaveBeenCalledWith("e1");
  });

  // The band is drawn on the canvas but it is not scenery: both its controls
  // are real focusable elements, so the empty lane is reachable without a
  // pointer at all.
  it("puts its name field and its discard control in the tab order", async () => {
    const user = userEvent.setup();
    renderBand();

    await user.tab();
    expect(screen.getByLabelText("Lane name")).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: /remove lane/i })).toHaveFocus();
  });

  it("says whether a hovering drop can land here", () => {
    renderBand({ dropState: "accepted" });

    expect(screen.getByText("drop to re-place here")).toBeInTheDocument();
  });
});
