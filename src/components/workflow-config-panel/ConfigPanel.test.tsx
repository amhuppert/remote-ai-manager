// @vitest-environment jsdom
/**
 * The host-aware config panel shell: scope row, entity header, push navigation
 * and the builder legend footer (design README §7, §12; Config Panel prototype).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MobilePanelVisibility } from "@/components/workflow-graph/mobile-panel-visibility";
import { ConfigPanel } from "./ConfigPanel";
import type { ConfigRootCard } from "./ConfigRootCardList";
import { navigationTriggerId } from "./navigation-ids";
import {
  createConfigScreenRegistry,
  type ConfigScreenDefinition,
} from "./screen-registry";
import { textPart, valuePart } from "./value-parts";

afterEach(cleanup);

const CARDS: ConfigRootCard[] = [
  {
    screenId: "gates",
    title: "Quality gates",
    overrideLabel: "1 role set here",
    lines: [
      { key: "validator", parts: [textPart("security"), textPart("style")] },
    ],
  },
  {
    screenId: "policy",
    title: "Execution policy",
    lines: [{ key: "iterations", parts: [valuePart("8")] }],
  },
];

const SCREENS: ConfigScreenDefinition[] = [
  {
    id: "gates",
    title: "Quality gates",
    overrideLabel: "1 role set here",
    render: ({ navigate }) => (
      <div>
        <p>gates screen body</p>
        <button
          type="button"
          id={navigationTriggerId("validator")}
          onClick={() => navigate("validator")}
        >
          Cohort roster
        </button>
      </div>
    ),
  },
  {
    id: "validator",
    title: "Validator cohort",
    render: ({ navigate }) => (
      <div>
        <p>validator screen body</p>
        <button
          type="button"
          id={navigationTriggerId("seat:security")}
          onClick={() => navigate("seat:security")}
        >
          security
        </button>
      </div>
    ),
  },
  {
    id: "seat:",
    title: (param) => `Seat · ${param}`,
    render: ({ param }) => <p>seat screen body for {param}</p>,
  },
  { id: "policy", title: "Execution policy", render: () => <p>policy body</p> },
];

const PANEL_PROPS: React.ComponentProps<typeof ConfigPanel> = {
  host: "builder",
  scope: "context",
  entityTitle: "Implement checkout",
  entityMeta: "ctx_checkout · lane delivery · owning",
  overrideSummary: "2 blocks · 1 role set here",
  hasOverrides: true,
  rootCards: CARDS,
  screens: createConfigScreenRegistry(SCREENS),
};

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof ConfigPanel>> = {},
) {
  return render(<ConfigPanel {...PANEL_PROPS} {...overrides} />);
}

describe("ConfigPanel shell", () => {
  it("shows the entity header at the root screen", () => {
    renderPanel();

    expect(screen.getByText("Implement checkout")).toBeInTheDocument();
    expect(
      screen.getByText("ctx_checkout · lane delivery · owning"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /quality gates/i }),
    ).toBeInTheDocument();
  });

  it("gives the builder host the scope switch and the legend footer", () => {
    const onScopeChange = vi.fn();
    renderPanel({ onScopeChange });

    const scopeRow = screen.getByRole("radiogroup", {
      name: /inspector scope/i,
    });
    expect(scopeRow).toBeInTheDocument();
    expect(screen.getByText("2 blocks · 1 role set here")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("radio", { name: "Workflow" }));
    expect(onScopeChange).toHaveBeenCalledWith("workflow");

    expect(
      screen.getByRole("button", { name: /reset all overrides/i }),
    ).toBeInTheDocument();
  });

  it("gives the execution host neither scope switch nor legend, and stays context-oriented", () => {
    renderPanel({ host: "execution", scope: "context" });

    expect(
      screen.queryByRole("radiogroup", { name: /inspector scope/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /reset all overrides/i }),
    ).not.toBeInTheDocument();
  });

  it("drills root → group → leaf, each level naming its parent in the back row", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    expect(screen.getByText("gates screen body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Context" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Quality gates",
    );

    fireEvent.click(screen.getByRole("button", { name: "Cohort roster" }));
    expect(screen.getByText("validator screen body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Quality gates" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "security" }));
    expect(
      screen.getByText(/seat screen body for security/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Validator cohort" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("config-screen-title")).toHaveTextContent(
      "Seat · security",
    );
  });

  it("goes back exactly one level", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cohort roster" }));
    fireEvent.click(screen.getByRole("button", { name: "security" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Back to Validator cohort" }),
    );
    expect(screen.getByText("validator screen body")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Back to Quality gates" }),
    );
    expect(screen.getByText("gates screen body")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to Context" }));
    expect(screen.getByText("Implement checkout")).toBeInTheDocument();
  });

  it("returns focus to the row that was drilled from", () => {
    renderPanel();

    const gatesCard = screen.getByRole("button", { name: /quality gates/i });
    gatesCard.focus();
    fireEvent.click(gatesCard);

    fireEvent.click(screen.getByRole("button", { name: "Back to Context" }));

    expect(
      screen.getByRole("button", { name: /quality gates/i }),
    ).toHaveFocus();
  });

  it("restores the scroll position the reader left the parent screen at", () => {
    renderPanel();

    const body = screen.getByTestId("config-panel-body");
    body.scrollTop = 148;

    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    expect(body.scrollTop).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Back to Context" }));
    expect(body.scrollTop).toBe(148);
  });

  it("names the parent 'Workflow' at workflow scope and 'Config' on the execution host", () => {
    const { unmount } = renderPanel({ scope: "workflow" });
    fireEvent.click(screen.getByRole("button", { name: /execution policy/i }));
    expect(
      screen.getByRole("button", { name: "Back to Workflow" }),
    ).toBeInTheDocument();
    unmount();

    renderPanel({ host: "execution" });
    fireEvent.click(screen.getByRole("button", { name: /execution policy/i }));
    expect(
      screen.getByRole("button", { name: "Back to Config" }),
    ).toBeInTheDocument();
  });

  it("returns to the root when the scope changes", () => {
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    expect(screen.getByText("gates screen body")).toBeInTheDocument();

    rerender(
      <ConfigPanel
        host="builder"
        scope="workflow"
        entityTitle="checkout-v2 release train"
        entityMeta="6 contexts"
        rootCards={CARDS}
        screens={createConfigScreenRegistry(SCREENS)}
      />,
    );

    expect(screen.queryByText("gates screen body")).not.toBeInTheDocument();
    expect(screen.getByText("checkout-v2 release train")).toBeInTheDocument();
  });

  it("opens directly on a deep-linked screen with its back row intact", () => {
    renderPanel({ initialScreenPath: ["gates", "validator"] });

    expect(screen.getByText("validator screen body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Quality gates" }),
    ).toBeInTheDocument();
  });

  it("shows the screen's own override badge in the deep header", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));

    expect(screen.getByTestId("config-screen-badge")).toHaveTextContent(
      "1 role set here",
    );
  });
});

describe("ConfigPanel affordance banners", () => {
  function renderExecution(
    overrides: Partial<React.ComponentProps<typeof ConfigPanel>> = {},
  ) {
    return renderPanel({ host: "execution", ...overrides });
  }

  it("says nothing while the context is editable", () => {
    renderExecution({ affordance: "editable" });

    expect(screen.queryByTestId("config-affordance-banner")).toBeNull();
  });

  it("renders the frozen banner with its lock", () => {
    renderExecution({ affordance: "frozen" });

    expect(screen.getByTestId("config-affordance-banner")).toHaveTextContent(
      "This context has completed — its configuration is frozen.",
    );
    expect(screen.getByTestId("config-banner-icon-lock")).toBeInTheDocument();
  });

  it("offers Pause to edit while the context is in progress", () => {
    const onPauseToEdit = vi.fn();
    renderExecution({ affordance: "pause-to-edit", onPauseToEdit });

    expect(screen.getByTestId("config-affordance-banner")).toHaveTextContent(
      "This context is in progress. Pause the workflow to edit it.",
    );
    expect(screen.getByTestId("config-banner-icon-pause")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Pause to edit" }));
    expect(onPauseToEdit).toHaveBeenCalledTimes(1);
  });

  it("shows the pending label and disables the action while pausing", () => {
    renderExecution({ affordance: "pause-to-edit", pausing: true });

    const action = screen.getByRole("button", { name: "Pausing…" });
    expect(action).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Pause to edit" })).toBeNull();
  });

  it("carries the classifier's read-only reason verbatim", () => {
    const { unmount } = renderExecution({
      affordance: "read-only",
      readOnlyReason: "halt-not-resumable",
    });
    expect(screen.getByTestId("config-affordance-banner")).toHaveTextContent(
      "This execution halted with a non-resumable reason and can no longer be edited.",
    );
    unmount();

    renderExecution({
      affordance: "read-only",
      readOnlyReason: "awaiting-definition-approval",
    });
    expect(screen.getByTestId("config-affordance-banner")).toHaveTextContent(
      "This plan is parked awaiting definition approval; approve or reject it before editing.",
    );
  });

  it("never raises a banner on the builder host", () => {
    renderPanel({ affordance: "frozen", readOnlyReason: "completed" });

    expect(screen.queryByTestId("config-affordance-banner")).toBeNull();
  });
});

describe("ConfigPanel save bar", () => {
  function renderSaveBar(
    overrides: Partial<React.ComponentProps<typeof ConfigPanel>> = {},
  ) {
    return renderPanel({
      host: "execution",
      affordance: "editable",
      ...overrides,
    });
  }

  it("is absent on the builder host and whenever the context is locked", () => {
    const { unmount } = renderPanel({ saveState: "dirty" });
    expect(screen.queryByTestId("config-save-bar")).toBeNull();
    unmount();

    renderSaveBar({ affordance: "frozen", saveState: "dirty" });
    expect(screen.queryByTestId("config-save-bar")).toBeNull();
  });

  it("disables Save with nothing to apply", () => {
    renderSaveBar({ saveState: "clean" });

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "No unsaved changes",
    );
  });

  it("enables Save once the draft is dirty", () => {
    const onSave = vi.fn();
    renderSaveBar({ saveState: "dirty", onSave });

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeEnabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Unsaved changes",
    );

    fireEvent.click(save);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("blocks Save and names the refusal it is blocked on", () => {
    renderSaveBar({
      saveState: "dirty",
      saveBlockedReason: "The output schema cannot be parsed.",
    });

    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Blocked: The output schema cannot be parsed.",
    );
  });

  it("withdraws the dictation submit promise while the save is blocked", () => {
    const onSave = vi.fn();
    renderSaveBar({
      saveState: "clean",
      voiceBusy: true,
      saveBlockedReason: "Another edit on this execution is still saving.",
      onSave,
    });

    const save = screen.getByRole("button", { name: "Save changes" });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Blocked: Another edit on this execution is still saving.",
    );
    fireEvent.click(save);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("names the paused execution while saving", () => {
    renderSaveBar({ saveState: "saving", resumable: true });

    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Applying to the paused execution",
    );
  });

  it("offers Resume workflow once the edit landed", () => {
    const onResume = vi.fn();
    renderSaveBar({ saveState: "saved", onResume, resumable: true });

    expect(screen.getByTestId("config-save-note")).toHaveTextContent(
      "Saved — the execution is still paused",
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume workflow" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("reports the resume it already accepted rather than inviting a second one", () => {
    const onResume = vi.fn();
    renderSaveBar({
      saveState: "saved",
      onResume,
      resumable: true,
      resuming: true,
    });

    const resume = screen.getByRole("button", { name: "Resuming…" });
    expect(resume).toBeDisabled();
    fireEvent.click(resume);
    expect(onResume).not.toHaveBeenCalled();
  });

  it("does not offer Resume workflow in any other state", () => {
    renderSaveBar({ saveState: "dirty" });

    expect(
      screen.queryByRole("button", { name: "Resume workflow" }),
    ).toBeNull();
  });

  it("announces a revision conflict and keeps Save reachable", () => {
    renderSaveBar({ saveState: "conflict" });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The execution changed since you started editing. Review your changes and retry.",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("announces the server's own refusal on a save error", () => {
    renderSaveBar({
      saveState: "error",
      saveErrorMessage:
        "Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry.",
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Live edit refused: lane delivery is mid-merge. Wait for the join to settle and retry.",
    );
  });

  it("keeps the save bar below the body, outside the scrolling region", () => {
    renderSaveBar({ saveState: "dirty" });

    const body = screen.getByTestId("config-panel-body");
    expect(body).not.toContainElement(screen.getByTestId("config-save-bar"));
  });
});

// README §12 — "The system back gesture and the back row do the same thing."
// Below the breakpoint each drill level fills the screen, so a gesture that
// left the page from three levels down would be a trap.
describe("ConfigPanel — system back gesture", () => {
  function setViewport(width: number) {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches:
            /\(max-width:\s*(\d+)px\)/.test(query) &&
            width <= Number(/\(max-width:\s*(\d+)px\)/.exec(query)?.[1]),
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
          addListener: () => {},
          removeListener: () => {},
          onchange: null,
          dispatchEvent: () => false,
        }) as unknown as MediaQueryList,
    );
  }

  function popstate() {
    fireEvent.popState(window);
  }

  afterEach(() => vi.restoreAllMocks());

  it("pops exactly one drill level, matching the back row", () => {
    setViewport(390);
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cohort roster" }));
    expect(screen.getByText("validator screen body")).toBeInTheDocument();

    popstate();

    expect(screen.getByText("gates screen body")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Back to Context" }),
    ).toBeInTheDocument();

    popstate();

    expect(screen.getByText("Implement checkout")).toBeInTheDocument();
  });

  it("pushes one history entry per level and no route change", () => {
    setViewport(390);
    const pushState = vi.spyOn(window.history, "pushState");
    const href = window.location.href;
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cohort roster" }));

    expect(pushState).toHaveBeenCalledTimes(2);
    expect(pushState.mock.calls.every((call) => call[2] === href)).toBe(true);
  });

  // The bottom toolbar leaves the panel mounted but hidden. A gesture aimed at
  // the visible panel must not be spent unwinding a stack nobody can see.
  it("hands the gesture back when its panel leaves the screen", () => {
    setViewport(390);
    const go = vi.spyOn(window.history, "go").mockImplementation(() => {});
    const { rerender } = render(
      <MobilePanelVisibility onScreen>
        <ConfigPanel {...PANEL_PROPS} />
      </MobilePanelVisibility>,
    );

    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    fireEvent.click(screen.getByRole("button", { name: "Cohort roster" }));

    rerender(
      <MobilePanelVisibility onScreen={false}>
        <ConfigPanel {...PANEL_PROPS} />
      </MobilePanelVisibility>,
    );

    // Both entries released at once — the panel owns none of the stack now.
    expect(go).toHaveBeenCalledWith(-2);

    // `go(-2)` is one traversal and so one pop, the panel's own; then a real
    // gesture arrives: it belongs to the page, and the hidden drill level
    // stands.
    popstate();
    popstate();

    // The drill level is kept, ready for a return to the panel; the gesture
    // simply was not the panel's to answer.
    expect(screen.getByText("validator screen body")).toBeInTheDocument();
  });

  it("leaves the back button to the app above the breakpoint", () => {
    setViewport(1440);
    const pushState = vi.spyOn(window.history, "pushState");
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /quality gates/i }));
    popstate();

    expect(pushState).not.toHaveBeenCalled();
    // The gesture belonged to the app's routes, so the drill level stands.
    expect(screen.getByText("gates screen body")).toBeInTheDocument();
  });
});
