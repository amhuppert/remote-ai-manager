// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { _useOverlayScopeStore } from "@/stores/overlay-scope.store";
import { useThinkingBlockExpansionHotkeys } from "./use-thinking-block-expansion-hotkeys";

function pressShiftKey(key: "c" | "e"): void {
  fireEvent.keyDown(document, {
    key: key.toUpperCase(),
    code: `Key${key.toUpperCase()}`,
    shiftKey: true,
  });
}

function Harness({ enabled = true }: { enabled?: boolean }): React.JSX.Element {
  const command = useThinkingBlockExpansionHotkeys(enabled);
  return (
    <output data-testid="state">
      {command.expanded ? "expanded" : "collapsed"}:{command.revision}
    </output>
  );
}

describe("useThinkingBlockExpansionHotkeys", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("collapses and expands thinking blocks through separate shortcuts", () => {
    render(<Harness />);

    expect(screen.getByTestId("state")).toHaveTextContent("expanded:0");
    pressShiftKey("c");
    expect(screen.getByTestId("state")).toHaveTextContent("collapsed:1");

    pressShiftKey("e");
    expect(screen.getByTestId("state")).toHaveTextContent("expanded:2");
  });

  it("does not react while disabled", () => {
    render(<Harness enabled={false} />);

    pressShiftKey("c");
    expect(screen.getByTestId("state")).toHaveTextContent("expanded:0");
  });
});
