// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { storybookAnnotations } from "@/test/storybook-setup";
import * as stories from "./TicketDetailPage.stories";

const pushMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: pushMock,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/tickets/command-center/12",
  useSearchParams: () => new URLSearchParams(),
}));

beforeAll(storybookAnnotations.beforeAll);
afterEach(() => {
  cleanup();
  pushMock.mockClear();
});

const {
  FullDossier,
  HistoricalSessions,
  ReplacedSessionHistory,
  DeleteConfirmation,
  TitleEditFailure,
  StartWorkDialog,
  StartWorkProvisioning,
  StartConflict,
  StartAfterSessionEnded,
  StartAfterCachedActiveSessionEnds,
} = composeStories(stories);

describe("TicketDetailPage stories", () => {
  it("FullDossier renders identity, status pill, type badge, and both rails", async () => {
    await FullDossier.run();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          name: "Ticket attachment index: virtualize long lists",
        }),
      ).toBeInTheDocument(),
    );

    // Identity + status pill + type badge.
    expect(screen.getByText("#12")).toBeInTheDocument();
    // The status appears both as the header pill and as the Select value.
    expect(screen.getAllByText("In Progress").length).toBeGreaterThan(0);
    expect(screen.getByText("feature")).toBeInTheDocument();

    // Header actions.
    expect(
      screen.getByRole("button", { name: "Copy ticket reference" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start work/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Delete ticket" }),
    ).toBeInTheDocument();

    // Description renders as markdown prose.
    expect(
      screen.getByText(/re-renders every entry on any SSE delta/),
    ).toBeInTheDocument();

    // Fields rail: free-transition selects + project + timestamps.
    const fields = screen.getByRole("region", { name: "Fields" });
    expect(
      within(fields).getByRole("combobox", { name: "Status" }),
    ).toBeInTheDocument();
    expect(
      within(fields).getByRole("combobox", { name: "Work type" }),
    ).toBeInTheDocument();
    expect(within(fields).getByText("command-center")).toBeInTheDocument();

    // Session history rail: the active link.
    expect(screen.getByText("csm/ticket-attachments")).toBeInTheDocument();
    expect(screen.getByText("active")).toBeInTheDocument();
  });

  it("HistoricalSessions lists ended links with their end reasons and no active card", async () => {
    await HistoricalSessions.run();
    await waitFor(() =>
      expect(screen.getByText("csm/spike-virtualize")).toBeInTheDocument(),
    );
    expect(screen.getByText("finished")).toBeInTheDocument();
    expect(screen.getByText("deleted")).toBeInTheDocument();
    expect(screen.queryByText("active")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "csm/spike-virtualize" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "csm/spike-window-index" }),
    ).not.toBeInTheDocument();
  });

  it("ReplacedSessionHistory does not link an old row to a same-name replacement", async () => {
    await ReplacedSessionHistory.run();
    await waitFor(() =>
      expect(screen.getByText("csm/spike-window-index")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("link", { name: "csm/spike-window-index" }),
    ).not.toBeInTheDocument();
  });

  it("DeleteConfirmation guards deletion behind an AlertDialog and leaves the view on confirm", async () => {
    // The story's play function clicks the header's Delete action.
    await DeleteConfirmation.run();
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("Delete ticket?");
    expect(dialog).toHaveTextContent("command-center#12");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(pushMock).toHaveBeenCalledWith("/tickets"));
  });

  it("TitleEditFailure restores the previous value and retries inline", async () => {
    await TitleEditFailure.run();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          name: "Ticket attachment index: virtualize long lists",
        }),
      ).toBeInTheDocument(),
    );

    // Click-to-edit, replace the title, commit with Enter.
    fireEvent.click(
      screen.getByRole("heading", {
        name: "Ticket attachment index: virtualize long lists",
      }),
    );
    const input = await screen.findByRole("textbox", { name: "Ticket title" });
    fireEvent.change(input, { target: { value: "Windowed dossier index" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // The first PATCH fails: the previous value is restored with inline retry.
    const retry = await screen.findByRole("button", {
      name: /retry/i,
    });
    expect(retry.closest("[role='alert']")).toHaveTextContent("Save failed");
    expect(
      screen.getByRole("heading", {
        name: "Ticket attachment index: virtualize long lists",
      }),
    ).toBeInTheDocument();

    // Retry re-issues the same edit; the server accepts the second attempt.
    fireEvent.click(retry);
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Windowed dossier index" }),
      ).toBeInTheDocument(),
    );
  });

  it("StartWorkDialog offers both modes and provisions to an active session", async () => {
    await StartWorkDialog.run();
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Start work");

    // Agent/prepared mode choice, agent pre-selected.
    const agent = within(dialog).getByRole("radio", {
      name: /agent starts immediately/i,
    });
    const prepared = within(dialog).getByRole("radio", {
      name: /prepared session/i,
    });
    expect(agent).toHaveAttribute("aria-checked", "true");
    expect(prepared).toHaveAttribute("aria-checked", "false");

    // Confirming provisions the session and closes the dialog; the dossier
    // reconciles to In Progress with the new session card active.
    fireEvent.click(within(dialog).getByRole("button", { name: "Start work" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByText("csm/ticket-12-work")).toBeInTheDocument(),
    );
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getAllByText("In Progress").length).toBeGreaterThan(0);
  });

  it("StartWorkProvisioning locks the mode choice but keeps Cancel enabled", async () => {
    await StartWorkProvisioning.run();
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(within(dialog).getByText("Provisioning…")).toBeInTheDocument(),
    );
    expect(
      within(dialog).getByRole("radio", { name: /agent starts immediately/i }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeEnabled();
  });

  it("StartAfterSessionEnded lets a stale un-ended link restart via the dialog", async () => {
    await StartAfterSessionEnded.run();
    const startButton = await screen.findByRole("button", {
      name: /start work/i,
    });

    // The liveness-aware session-link map (the session already ended) must
    // override the stale `endedAt: null` row before the click is judged.
    await waitFor(() =>
      expect(startButton).not.toHaveAttribute("data-start-conflict"),
    );
    expect(screen.queryByText("active")).not.toBeInTheDocument();
    fireEvent.click(startButton);

    expect(await screen.findByRole("dialog")).toHaveTextContent("Start work");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("StartAfterCachedActiveSessionEnds re-checks liveness at click time instead of trusting the cached map", async () => {
    await StartAfterCachedActiveSessionEnds.run();
    const startButton = await screen.findByRole("button", {
      name: /start work/i,
    });

    // The map was cached while the session was still active…
    await waitFor(() =>
      expect(startButton).toHaveAttribute("data-start-conflict", "true"),
    );
    fireEvent.click(startButton);

    // …but the session has since ended, and no lifecycle path invalidates
    // the cached map. The click-time liveness refresh must learn the truth
    // and open the start dialog — not block restart with the conflict alert.
    expect(await screen.findByRole("dialog")).toHaveTextContent("Start work");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("StartConflict surfaces the active session pre-dialog as an AlertDialog", async () => {
    await StartConflict.run();
    const alert = await screen.findByRole("alertdialog");
    expect(alert).toHaveTextContent("csm/ticket-attachments");
    // The mode-choice dialog never opened.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("TitleEditFailure supports Escape to abandon the edit", async () => {
    await TitleEditFailure.run();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", {
          name: "Ticket attachment index: virtualize long lists",
        }),
      ).toBeInTheDocument(),
    );
    const editTitle = screen.getByRole("button", { name: "Edit title" });
    expect(editTitle.className).toContain("min-h-[24px]");
    expect(editTitle.className).toContain("min-w-[24px]");

    fireEvent.click(
      screen.getByRole("heading", {
        name: "Ticket attachment index: virtualize long lists",
      }),
    );
    const input = await screen.findByRole("textbox", { name: "Ticket title" });
    fireEvent.change(input, { target: { value: "Abandoned draft" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(
      screen.getByRole("heading", {
        name: "Ticket attachment index: virtualize long lists",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Ticket title" }),
    ).not.toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit title" }),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit title" }),
      ),
    );
  });

  it("FullDossier returns focus to the description Edit button after Cancel or Escape", async () => {
    await FullDossier.run();
    const description = await screen.findByRole("region", {
      name: "Description",
    });
    const edit = within(description).getByRole("button", { name: "Edit" });

    fireEvent.click(edit);
    const textarea = await within(description).findByRole("textbox", {
      name: "Ticket description",
    });
    fireEvent.keyDown(textarea, { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(description).getByRole("button", { name: "Edit" }),
      ),
    );

    fireEvent.click(within(description).getByRole("button", { name: "Edit" }));
    fireEvent.click(
      await within(description).findByRole("button", { name: "Cancel" }),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(description).getByRole("button", { name: "Edit" }),
      ),
    );
  });

  it("FullDossier returns focus to each editor trigger after a successful save", async () => {
    await FullDossier.run();
    await screen.findByRole("heading", {
      name: "Ticket attachment index: virtualize long lists",
    });

    fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
    const title = await screen.findByRole("textbox", { name: "Ticket title" });
    fireEvent.change(title, { target: { value: "Windowed ticket index" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("heading", { name: "Windowed ticket index" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Edit title" }),
      ),
    );

    const description = screen.getByRole("region", { name: "Description" });
    fireEvent.click(within(description).getByRole("button", { name: "Edit" }));
    fireEvent.change(
      await within(description).findByRole("textbox", {
        name: "Ticket description",
      }),
      { target: { value: "Window only the visible attachment entries." } },
    );
    fireEvent.click(within(description).getByRole("button", { name: "Save" }));
    await within(description).findByText(
      "Window only the visible attachment entries.",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(description).getByRole("button", { name: "Edit" }),
      ),
    );
  });
});
