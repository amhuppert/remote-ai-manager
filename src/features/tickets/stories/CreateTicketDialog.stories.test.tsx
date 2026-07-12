// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./CreateTicketDialog.stories";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/tickets",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(storybookAnnotations.beforeAll);
afterEach(() => {
  cleanup();
  pushMock.mockClear();
});

const {
  Default,
  ValidationError,
  ProjectsPending,
  ProjectsFailure,
  Pending,
  FailurePreservesInput,
  Success,
} = composeStories(stories);

describe("CreateTicketDialog stories", () => {
  it("Default pre-fills the project and defaults the work type to Feature", async () => {
    await Default.run();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("New ticket");

    // Side-by-side selects: project pre-filled from the entry, type Feature.
    const projectSelect = screen.getByRole("combobox", {
      name: "Project",
    }) as HTMLButtonElement;
    const workTypeSelect = screen.getByRole("combobox", {
      name: "Work type",
    }) as HTMLButtonElement;
    expect(projectSelect).toHaveTextContent("command-center");
    expect(workTypeSelect).toHaveTextContent("Feature");
    expect(projectSelect.labels?.[0]).toHaveTextContent("Project");
    expect(workTypeSelect.labels?.[0]).toHaveTextContent("Work type");
    expect(projectSelect).toHaveAttribute("aria-required", "true");

    expect(screen.getByLabelText("Title")).toBeRequired();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(screen.getByLabelText(/description/i)).toHaveValue("");
  });

  it("ValidationError reports missing fields on submit and sends nothing", async () => {
    await ValidationError.run();
    expect(await screen.findByText("Title is required.")).toBeInTheDocument();
    expect(screen.getByText("Choose an owning project.")).toBeInTheDocument();
    const project = screen.getByRole("combobox", { name: "Project" });
    const title = screen.getByLabelText("Title");
    expect(project).toHaveAttribute("aria-invalid", "true");
    expect(title).toHaveAttribute("aria-invalid", "true");
    expect(project).toHaveAccessibleDescription("Choose an owning project.");
    expect(title).toHaveAccessibleDescription("Title is required.");
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    await waitFor(() => expect(document.activeElement).toBe(project));
    // Still on the form — no success notice appeared.
    expect(screen.queryByText(/created/i)).not.toBeInTheDocument();
  });

  it("ProjectsPending disables choices and submission while ownership is unresolved", async () => {
    await ProjectsPending.run();

    expect(screen.getByRole("combobox", { name: "Project" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Create ticket" }),
    ).toBeDisabled();
    expect(screen.getByText("Loading projects…")).toBeInTheDocument();
  });

  it("ProjectsFailure announces the failure and retries discovery", async () => {
    await ProjectsFailure.run();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load projects");
    expect(screen.getByRole("combobox", { name: "Project" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Create ticket" }),
    ).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Retry projects" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Project" })).toBeEnabled(),
    );
    expect(
      screen.queryByText(/Couldn't load projects/),
    ).not.toBeInTheDocument();
  });

  it("Pending locks the inputs but keeps Cancel enabled", async () => {
    await Pending.run();
    await waitFor(() => expect(screen.getByLabelText("Title")).toBeDisabled());
    expect(screen.getByLabelText(/description/i)).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Create ticket" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("FailurePreservesInput surfaces the error and keeps every value", async () => {
    await FailurePreservesInput.run();
    expect(
      await screen.findByText("Ticket creation failed — nothing was saved."),
    ).toBeInTheDocument();

    // Input preserved for another attempt; the form is unlocked again.
    expect(screen.getByLabelText("Title")).toHaveValue(
      "SSE reconnect drops ticket deltas",
    );
    expect(screen.getByLabelText("Title")).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent(
      "command-center",
    );
  });

  it("Success reports the identifier and nudges adding context on the dossier", async () => {
    await Success.run();
    expect(await screen.findByText("command-center#13")).toBeInTheDocument();

    const addContext = screen.getByRole("button", { name: "Add context" });
    fireEvent.click(addContext);
    await waitFor(() =>
      expect(pushMock).toHaveBeenCalledWith("/tickets/command-center/13"),
    );
  });
});
