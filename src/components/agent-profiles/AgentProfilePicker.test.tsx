// @vitest-environment jsdom
/**
 * The one profile picker every creation path renders (D23).
 *
 * Driven through the production query hook with the real query key seeded, so
 * these assertions cover the wiring a creation surface actually gets — not a
 * hand-passed options array the component could diverge from.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type {
  AgentProfileLibraryItem,
  AgentProfileLibraryListing,
} from "@/lib/agent-profiles/schemas";

import AgentProfilePicker from "./AgentProfilePicker";
import { STANDARD_AGENT_PROFILE_VALUE } from "./agent-profile-picker-state";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const PROJECT = "my-app";

function libraryItem(
  overrides: Partial<AgentProfileLibraryItem> &
    Pick<AgentProfileLibraryItem, "ref">,
): AgentProfileLibraryItem {
  return {
    name: overrides.ref.id,
    description: "A profile",
    revision: 1,
    recommendedFor: [],
    tags: [],
    readOnly: overrides.ref.tier === "builtin",
    ...overrides,
  };
}

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    libraryItem({
      ref: { tier: "builtin", id: "standard-agent" },
      name: "Standard Agent",
      description: "The default agent.",
      recommendedFor: ["conversation"],
    }),
    libraryItem({
      ref: { tier: "project", id: "house-style" },
      name: "House Style",
      description: "Writes the way this repo writes.",
      recommendedFor: ["conversation"],
    }),
    libraryItem({
      ref: { tier: "global", id: "security-reviewer" },
      name: "Security Reviewer",
      description: "Reads a diff for exploitable defects.",
      recommendedFor: ["workflow_validator"],
    }),
  ],
  diagnostics: [],
};

function renderPicker(
  props: Partial<React.ComponentProps<typeof AgentProfilePicker>> = {},
  { seed = true }: { seed?: boolean } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (seed) {
    queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
  }
  const onChange = props.onChange ?? vi.fn();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <AgentProfilePicker
        projectName={PROJECT}
        value={props.value ?? STANDARD_AGENT_PROFILE_VALUE}
        onChange={onChange}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { view, onChange, queryClient };
}

describe("AgentProfilePicker", () => {
  it("shows the Standard Agent default with its Built-in provenance", () => {
    renderPicker();

    const trigger = screen.getByRole("combobox", { name: /agent profile/i });
    expect(trigger).toHaveTextContent("Standard Agent");
    expect(trigger).toHaveTextContent("Built-in");
  });

  it("still offers the Standard Agent default before the library resolves", () => {
    renderPicker({}, { seed: false });

    expect(
      screen.getByRole("combobox", { name: /agent profile/i }),
    ).toHaveTextContent("Standard Agent");
  });

  it("lists every tier with a provenance badge on each option", async () => {
    renderPicker({ open: true });

    const options = screen.getAllByRole("option");
    const labels = options.map((option) => option.textContent ?? "");
    expect(labels.some((l) => l.includes("Standard Agent"))).toBe(true);
    expect(labels.some((l) => l.includes("House Style"))).toBe(true);
    expect(labels.some((l) => l.includes("Security Reviewer"))).toBe(true);

    // Tier provenance rides on the option itself, because two tiers can hold
    // the same id and the name alone would not say which one this is.
    const houseStyle = options.find((o) =>
      (o.textContent ?? "").includes("House Style"),
    );
    expect(houseStyle).toHaveTextContent("Project");
    const securityReviewer = options.find((o) =>
      (o.textContent ?? "").includes("Security Reviewer"),
    );
    expect(securityReviewer).toHaveTextContent("Global");
  });

  it("warns advisorily about a selection outside recommendedFor", () => {
    renderPicker({ value: "global:security-reviewer" });

    const warning = screen.getByRole("status");
    expect(warning).toHaveTextContent(/Security Reviewer is recommended for/i);
    expect(warning).toHaveTextContent(/still use it/i);
  });

  it("keeps a profile outside recommendedFor fully selectable", () => {
    // Advisory means selectable: the option is neither disabled nor removed.
    // Asserted with the listbox open, which is also why the warning is checked
    // separately — Radix hides the rest of the document from the a11y tree
    // while a listbox is open.
    renderPicker({ value: STANDARD_AGENT_PROFILE_VALUE, open: true });

    const option = screen
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("Security Reviewer"));
    expect(option).toBeDefined();
    expect(option).not.toHaveAttribute("data-disabled");
  });

  it("says nothing when the selection is recommended for this audience", () => {
    renderPicker({ value: "project:house-style" });

    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports the qualified reference the author picked", async () => {
    const user = userEvent.setup();
    const { onChange } = renderPicker({ open: true });

    const option = screen
      .getAllByRole("option")
      .find((o) => (o.textContent ?? "").includes("House Style"));
    expect(option).toBeDefined();
    await user.click(option!);

    expect(onChange).toHaveBeenCalledWith({
      value: "project:house-style",
      ref: { tier: "project", id: "house-style" },
    });
  });
});
