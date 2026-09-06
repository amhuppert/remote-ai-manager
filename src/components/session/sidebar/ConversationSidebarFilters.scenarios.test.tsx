// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ConversationSidebarFilters from "./ConversationSidebarFilters";
import { useSessionDetailStore } from "@/stores/session-detail.store";

function FiltersHarness() {
  const [project, setProject] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [workflows, setWorkflows] = useState(false);
  return (
    <ConversationSidebarFilters
      projects={["cc", "recall"]}
      project={project}
      onProjectChange={setProject}
      includeGraphWorkflows={workflows}
      onGraphWorkflowsChange={setWorkflows}
      includeArchived={archived}
      onArchivedChange={setArchived}
    />
  );
}
afterEach(() => {
  cleanup();
  useSessionDetailStore.getState().resetStore();
});
describe("ConversationSidebarFilters", () => {
  it("selects a project and returns to all projects", async () => {
    const user = userEvent.setup();
    render(<FiltersHarness />);
    await user.click(
      screen.getByRole("combobox", { name: "Filter by project" }),
    );
    await user.click(screen.getByRole("option", { name: "recall" }));
    expect(screen.getByRole("combobox")).toHaveTextContent("recall");
    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "All projects" }));
    expect(screen.getByRole("combobox")).toHaveTextContent("All projects");
  });
  it("defaults archived off and toggles it", () => {
    render(<FiltersHarness />);
    const control = screen.getByRole("switch", {
      name: "Show archived conversations",
    });
    expect(control).toHaveAttribute("aria-checked", "false");
    fireEvent.click(control);
    expect(control).toHaveAttribute("aria-checked", "true");
  });
});
