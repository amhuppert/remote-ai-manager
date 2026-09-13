// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery } from "@/test/component-mocks";
import { checkpointForkStoryFetch } from "./checkpoint-fork-story-fixtures";
import CheckpointRelatedWorkPicker from "./CheckpointRelatedWorkPicker";
const target = {
  scope: "project",
  projectName: "test",
  conversationId: "source",
} as const;
afterEach(() => vi.unstubAllGlobals());
it("keeps the chosen workflow address when searching its assignments", async () => {
  const base = checkpointForkStoryFetch(target);
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if (
        url.pathname === "/api/live-references/executions" &&
        url.searchParams.get("q")
      )
        return new Response(JSON.stringify({ items: [] }));
      return base(input, init);
    },
  );
  const user = userEvent.setup();
  renderWithQuery(
    <CheckpointRelatedWorkPicker
      projectName="test"
      value={null}
      onChange={() => {}}
      disabled={false}
    />,
  );
  await user.click(screen.getByRole("combobox", { name: "Related work" }));
  await user.click(screen.getByRole("option", { name: "Workflow assignment" }));
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Workflow execution" }),
    ).not.toBeDisabled(),
  );
  await user.click(
    screen.getByRole("combobox", { name: "Workflow execution" }),
  );
  await user.click(
    await screen.findByRole("option", { name: /Checkpoint delivery/ }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Assignment" }),
    ).not.toBeDisabled(),
  );
  await user.type(
    screen.getByRole("textbox", { name: "Search related work" }),
    "Implementer",
  );
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Assignment" }),
    ).not.toBeDisabled(),
  );
  await user.click(screen.getByRole("combobox", { name: "Assignment" }));
  expect(await screen.findAllByRole("option")).not.toHaveLength(0);
});
