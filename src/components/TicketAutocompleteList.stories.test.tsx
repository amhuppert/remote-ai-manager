// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./TicketAutocompleteList.stories";

beforeAll(storybookAnnotations.beforeAll);
afterEach(cleanup);

const { Default, CrossProject, Loading, Empty, ErrorState, Mobile } =
  composeStories(stories);

describe("TicketAutocompleteList stories", () => {
  it("renders the default and cross-project selections", async () => {
    await Default.run();
    expect(
      screen.getByRole("listbox", { name: "Tickets" }),
    ).toBeInTheDocument();
    expect(screen.getByText("command-center#12")).toBeInTheDocument();
    cleanup();

    await CrossProject.run();
    expect(
      screen.getByText("api-service#31").closest("[role=option]"),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("renders loading, empty, error, and mobile states", async () => {
    await Loading.run();
    expect(screen.getByText("Loading tickets...")).toBeInTheDocument();
    cleanup();
    await Empty.run();
    expect(screen.getByText("No matching tickets")).toBeInTheDocument();
    cleanup();
    await ErrorState.run();
    expect(screen.getByText("Failed to load tickets")).toBeInTheDocument();
    cleanup();
    await Mobile.run();
    expect(
      screen.getByRole("listbox", { name: "Tickets" }),
    ).toBeInTheDocument();
  });
});
