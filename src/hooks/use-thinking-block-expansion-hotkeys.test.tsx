// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import { createHotkeyDispatcher } from "@/lib/hotkeys/dispatcher";
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

function renderHarness(enabled = true): void {
  render(
    <HotkeyProvider dispatcher={createHotkeyDispatcher()}>
      <Harness enabled={enabled} />
    </HotkeyProvider>,
  );
}

describe("useThinkingBlockExpansionHotkeys", () => {
  beforeEach(() => {
    _useOverlayScopeStore.setState({ openStack: [] });
  });

  it("collapses and expands thinking blocks through separate shortcuts", () => {
    renderHarness();

    expect(screen.getByTestId("state")).toHaveTextContent("expanded:0");
    pressShiftKey("c");
    expect(screen.getByTestId("state")).toHaveTextContent("collapsed:1");

    pressShiftKey("e");
    expect(screen.getByTestId("state")).toHaveTextContent("expanded:2");
  });

  it("does not react while disabled", () => {
    renderHarness(false);

    pressShiftKey("c");
    expect(screen.getByTestId("state")).toHaveTextContent("expanded:0");
  });
});
