// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import {
  useComposerFocus,
  type ComposerFocusHandle,
} from "@/features/session/prompt/use-composer-focus";

function readFlag(): boolean {
  return useSessionDetailStore.getState().composerFocused;
}

// Buttons that exercise the portal-overlay control signal. Rendered outside the
// region so a click does not affect editor focus tracking.
function ControlOpener({
  setControlActive,
}: {
  setControlActive: ComposerFocusHandle["setControlActive"];
}) {
  return (
    <>
      <button
        data-testid="open-capabilities"
        onClick={() => setControlActive("capabilities", true)}
      >
        open capabilities
      </button>
      <button
        data-testid="close-capabilities"
        onClick={() => setControlActive("capabilities", false)}
      >
        close capabilities
      </button>
      <button
        data-testid="open-sheet"
        onClick={() => setControlActive("mobileSheet", true)}
      >
        open sheet
      </button>
      <button
        data-testid="close-sheet"
        onClick={() => setControlActive("mobileSheet", false)}
      >
        close sheet
      </button>
    </>
  );
}

function Harness() {
  const { containerRef, onFocus, onBlur, setControlActive } =
    useComposerFocus();
  return (
    <div
      ref={containerRef}
      onFocus={onFocus}
      onBlur={onBlur}
      data-testid="region"
    >
      <textarea data-testid="editor" />
      <button data-testid="model">model</button>
      <button data-testid="effort">effort</button>
      <button data-testid="debug">debug</button>
      <button data-testid="voice">voice</button>
      <ControlOpener setControlActive={setControlActive} />
    </div>
  );
}

describe("useComposerFocus", () => {
  beforeEach(() => {
    useSessionDetailStore.getState().resetStore();
  });

  it("sets the flag true when the editor gains focus", () => {
    const { getByTestId } = render(<Harness />);
    expect(readFlag()).toBe(false);

    fireEvent.focus(getByTestId("editor"));

    expect(readFlag()).toBe(true);
  });

  it.each(["model", "effort", "debug", "voice"])(
    "keeps the flag true when focus moves to the in-flow %s control inside the region",
    (control) => {
      const { getByTestId } = render(<Harness />);
      const editor = getByTestId("editor");
      fireEvent.focus(editor);
      expect(readFlag()).toBe(true);

      fireEvent.blur(editor, { relatedTarget: getByTestId(control) });

      expect(readFlag()).toBe(true);
    },
  );

  it("holds the flag true while the capabilities drawer is open even though focus left the region", () => {
    const { getByTestId } = render(<Harness />);
    const editor = getByTestId("editor");
    fireEvent.focus(editor);

    fireEvent.click(getByTestId("open-capabilities"));
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(readFlag()).toBe(true);

    fireEvent.click(getByTestId("close-capabilities"));
    expect(readFlag()).toBe(false);
  });

  it("holds the flag true while the mobile sheet is open even though focus left the region", () => {
    const { getByTestId } = render(<Harness />);
    const editor = getByTestId("editor");
    fireEvent.focus(editor);

    fireEvent.click(getByTestId("open-sheet"));
    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(readFlag()).toBe(true);

    fireEvent.click(getByTestId("close-sheet"));
    expect(readFlag()).toBe(false);
  });

  it("clears the flag when focus leaves the region with no active controls", () => {
    const { getByTestId } = render(<Harness />);
    const editor = getByTestId("editor");
    fireEvent.focus(editor);
    expect(readFlag()).toBe(true);

    fireEvent.blur(editor, { relatedTarget: document.body });
    expect(readFlag()).toBe(false);
  });

  it("clears the flag when focus leaves to a null relatedTarget", () => {
    const { getByTestId } = render(<Harness />);
    const editor = getByTestId("editor");
    fireEvent.focus(editor);
    expect(readFlag()).toBe(true);

    fireEvent.blur(editor, { relatedTarget: null });
    expect(readFlag()).toBe(false);
  });

  it("clears the flag on unmount so leaving the composer drops emphasis", () => {
    const { getByTestId, unmount } = render(<Harness />);
    fireEvent.focus(getByTestId("editor"));
    expect(readFlag()).toBe(true);

    unmount();

    expect(readFlag()).toBe(false);
  });
});
