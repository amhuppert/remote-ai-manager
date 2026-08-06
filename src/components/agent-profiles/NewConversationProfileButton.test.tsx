// @vitest-environment jsdom
/**
 * The profile-selecting half of the two list surfaces that create a
 * conversation (the session sidebar and the project cockpit's tab strip).
 *
 * Those surfaces create with one click, so the picker lives behind a companion
 * control rather than replacing the fast path — R7.1 asks for a visible picker
 * defaulting to the Standard Agent on each creation path, not for a form in
 * front of every new conversation.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";

import NewConversationProfileButton from "./NewConversationProfileButton";

Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const PROJECT = "my-app";

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    {
      ref: { tier: "builtin", id: "standard-agent" },
      name: "Standard Agent",
      description: "The default agent.",
      revision: 1,
      recommendedFor: ["conversation"],
      tags: [],
      readOnly: true,
    },
    {
      ref: { tier: "project", id: "house-style" },
      name: "House Style",
      description: "Writes the way this repo writes.",
      revision: 3,
      recommendedFor: ["conversation"],
      tags: [],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

function renderButton(onCreate = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
  render(
    <QueryClientProvider client={queryClient}>
      <NewConversationProfileButton
        projectName={PROJECT}
        onCreate={onCreate}
        pending={false}
      />
    </QueryClientProvider>,
  );
  return { onCreate };
}

describe("NewConversationProfileButton", () => {
  it("opens a picker that starts on the Standard Agent", async () => {
    const user = userEvent.setup();
    renderButton();

    await user.click(
      screen.getByRole("button", { name: /choose an agent profile/i }),
    );

    expect(
      await screen.findByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");
  });

  it("creates under the Standard Agent when the author changes nothing", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderButton();

    await user.click(
      screen.getByRole("button", { name: /choose an agent profile/i }),
    );
    await user.click(
      await screen.findByRole("button", { name: /create conversation/i }),
    );

    expect(onCreate).toHaveBeenCalledWith({
      tier: "builtin",
      id: "standard-agent",
    });
  });

  it("creates under the profile the author picked", async () => {
    const user = userEvent.setup();
    const { onCreate } = renderButton();

    await user.click(
      screen.getByRole("button", { name: /choose an agent profile/i }),
    );
    await user.click(
      await screen.findByRole("combobox", { name: /agent profile/i }),
    );
    await user.click(
      await screen.findByRole("option", { name: /House Style/ }),
    );
    await user.click(
      screen.getByRole("button", { name: /create conversation/i }),
    );

    expect(onCreate).toHaveBeenCalledWith({
      tier: "project",
      id: "house-style",
    });
  });
});
