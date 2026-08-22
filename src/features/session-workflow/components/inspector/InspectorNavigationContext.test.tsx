// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  InspectorNavigationProvider,
  useInspectorNavigation,
  useInspectorNavigationState,
} from "./InspectorNavigationContext";
import {
  ADVISORY_ORIGIN,
  OUTPUT_SCHEMA_REPAIR,
  type InspectorDestination,
  type InspectorNavigationRequest,
} from "./navigation";

function DeepLink({
  contextId,
  destination,
  label,
}: {
  contextId: string;
  destination: InspectorDestination;
  label: string;
}): React.JSX.Element {
  const { openContext } = useInspectorNavigation();
  return (
    <button type="button" onClick={() => openContext(contextId, destination)}>
      {label}
    </button>
  );
}

function Host({
  onSelectContext,
  seen,
}: {
  onSelectContext: (contextId: string) => void;
  seen: (InspectorNavigationRequest | null)[];
}): React.JSX.Element {
  const { request, handle } = useInspectorNavigationState(onSelectContext);
  seen.push(request);
  return (
    <InspectorNavigationProvider handle={handle}>
      <DeepLink
        contextId="context-implement"
        destination={OUTPUT_SCHEMA_REPAIR}
        label="Edit schema"
      />
      <DeepLink
        contextId="context-plan"
        destination={ADVISORY_ORIGIN({
          roundSeq: 7,
          assignmentId: "security",
          ordinal: 1,
        })}
        label="Open advisory origin"
      />
      <span data-testid="request">{JSON.stringify(request)}</span>
    </InspectorNavigationProvider>
  );
}

function renderWithProvider(onSelectContext: (contextId: string) => void) {
  const seen: (InspectorNavigationRequest | null)[] = [];
  render(<Host onSelectContext={onSelectContext} seen={seen} />);
  return seen;
}

describe("InspectorNavigationProvider", () => {
  it("selects the context and states where in it to open", () => {
    const onSelectContext = vi.fn();
    renderWithProvider(onSelectContext);

    fireEvent.click(screen.getByRole("button", { name: "Edit schema" }));

    expect(onSelectContext).toHaveBeenCalledWith("context-implement");
    expect(JSON.parse(screen.getByTestId("request").textContent!)).toEqual({
      contextId: "context-implement",
      tab: "config",
      screen: ["brief", "schema"],
      seq: 1,
    });
  });

  it("routes an advisory link by the advisory's own identity", () => {
    const onSelectContext = vi.fn();
    renderWithProvider(onSelectContext);

    fireEvent.click(
      screen.getByRole("button", { name: "Open advisory origin" }),
    );

    expect(onSelectContext).toHaveBeenCalledWith("context-plan");
    expect(JSON.parse(screen.getByTestId("request").textContent!)).toEqual({
      contextId: "context-plan",
      tab: "history",
      advisory: { roundSeq: 7, assignmentId: "security", ordinal: 1 },
      seq: 1,
    });
  });

  it("keeps one counter across destinations, so any repeat re-opens", () => {
    renderWithProvider(vi.fn());

    fireEvent.click(screen.getByRole("button", { name: "Edit schema" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open advisory origin" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit schema" }));

    expect(JSON.parse(screen.getByTestId("request").textContent!).seq).toBe(3);
  });

  it("starts with nothing requested", () => {
    const seen = renderWithProvider(vi.fn());

    expect(seen[0]).toBeNull();
  });

  it("is inert outside a provider rather than throwing", () => {
    const onSelectContext = vi.fn();
    render(
      <DeepLink
        contextId="context-implement"
        destination={OUTPUT_SCHEMA_REPAIR}
        label="Edit schema"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit schema" }));

    expect(onSelectContext).not.toHaveBeenCalled();
  });
});
