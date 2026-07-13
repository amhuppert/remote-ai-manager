// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { composeStories } from "@storybook/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { storybookAnnotations } from "@/test/storybook-setup";
import AttachmentIndex from "@/features/tickets/components/AttachmentIndex";
import * as stories from "./AttachmentIndex.stories";

beforeAll(storybookAnnotations.beforeAll);
afterEach(cleanup);

const { AllKinds, EmptyIndex, NotePreview, AddDialog, FailedFileUpload } =
  composeStories(stories);

const NOTE_DESCRIPTION = "Constraints agreed with maintainers before starting.";
const FILE_DESCRIPTION =
  "The agreed v2 API contract — endpoints, payload shapes, and error codes.";
const CONVERSATION_DESCRIPTION =
  "Design collaboration where the virtualization approach was chosen.";

async function findEntry(name: string): Promise<HTMLElement> {
  return await screen.findByRole("listitem", { name });
}

describe("AttachmentIndex stories", () => {
  it("AllKinds leads every entry with its description over kind chip, metadata, and actions", async () => {
    await AllKinds.run();

    const descriptions = [
      FILE_DESCRIPTION,
      "Design collaboration where the virtualization approach was chosen.",
      "The spike session that produced the windowing prototype.",
      "Parent epic tracking the dossier performance work.",
      NOTE_DESCRIPTION,
    ];
    for (const description of descriptions) {
      const entry = await findEntry(description);
      expect(within(entry).getByText(description)).toBeInTheDocument();
      expect(
        within(entry).getByRole("button", { name: "View" }),
      ).toBeInTheDocument();
      expect(
        within(entry).getByRole("button", { name: "Edit" }),
      ).toBeInTheDocument();
      expect(
        within(entry).getByRole("button", { name: "Remove" }),
      ).toBeInTheDocument();
    }

    // Kind chips.
    for (const chip of [
      "file",
      "conversation",
      "session",
      "related ticket",
      "note",
    ]) {
      expect(screen.getByText(chip)).toBeInTheDocument();
    }

    // Mono metadata leads with the file name and human size.
    const fileEntry = await findEntry(FILE_DESCRIPTION);
    expect(within(fileEntry).getByText(/api-contract\.md/)).toBeInTheDocument();
    expect(within(fileEntry).getByText(/2\.0 KB/)).toBeInTheDocument();

    // The count pill reflects the index size.
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("AllKinds links related-ticket entries to the referenced ticket detail route", async () => {
    await AllKinds.run();
    const entry = await findEntry(
      "Parent epic tracking the dossier performance work.",
    );
    const link = within(entry).getByRole("link", {
      name: /command-center#7/,
    });
    expect(link).toHaveAttribute("href", "/tickets/command-center/7");
  });

  it("exposes attachment action targets and expanded panel state", async () => {
    await AllKinds.run();
    const entry = await findEntry(NOTE_DESCRIPTION);
    const view = within(entry).getByRole("button", { name: "View" });
    const edit = within(entry).getByRole("button", { name: "Edit" });
    const remove = within(entry).getByRole("button", { name: "Remove" });

    for (const action of [view, edit, remove]) {
      expect(action).toHaveClass("min-h-[24px]", "min-w-[24px]");
    }

    expect(view).toHaveAttribute("aria-expanded", "false");
    expect(edit).toHaveAttribute("aria-expanded", "false");
    const previewId = view.getAttribute("aria-controls");
    const editId = edit.getAttribute("aria-controls");
    expect(previewId).toBeTruthy();
    expect(editId).toBeTruthy();

    fireEvent.click(view);
    expect(view).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(previewId!)).toBeInTheDocument();

    fireEvent.click(edit);
    expect(view).toHaveAttribute("aria-expanded", "false");
    expect(edit).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(previewId!)).not.toBeInTheDocument();
    expect(document.getElementById(editId!)).toBeInTheDocument();
  });

  it("EmptyIndex shows the zero state with the Add context affordance", async () => {
    await EmptyIndex.run();
    expect(
      await screen.findByRole("button", { name: "Add context" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/No context attachments yet/)).toBeInTheDocument();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("NotePreview expands the note's markdown in place and collapses again", async () => {
    await NotePreview.run();

    // The play function clicked View on the note entry — resolve renders.
    // The note body renders through the deferred markdown adapter, whose dynamic
    // import can exceed the default 1s waitFor budget under full-suite load.
    await waitFor(
      () => expect(screen.getByText("keep keyboard nav")).toBeInTheDocument(),
      { timeout: 15000 },
    );

    // Collapse: the same action toggles the preview away.
    const entry = await findEntry(NOTE_DESCRIPTION);
    fireEvent.click(within(entry).getByRole("button", { name: "View" }));
    await waitFor(() =>
      expect(screen.queryByText("keep keyboard nav")).not.toBeInTheDocument(),
    );
  });

  it("expands a file preview with its resolved utf8 content", async () => {
    await AllKinds.run();
    const entry = await findEntry(FILE_DESCRIPTION);
    fireEvent.click(within(entry).getByRole("button", { name: "View" }));
    await waitFor(
      () =>
        expect(
          screen.getByText(/GET \/api\/tickets returns the lean list/),
        ).toBeInTheDocument(),
      { timeout: 15000 },
    );
  });

  it("AddDialog gates submission on the required description", async () => {
    await AddDialog.run();

    const dialog = await screen.findByRole("dialog", { name: "Add context" });
    // Kind picker offers all five kinds.
    for (const kind of [
      "File",
      "Conversation",
      "Session",
      "Related ticket",
      "Note",
    ]) {
      expect(
        within(dialog).getByRole("radio", { name: kind }),
      ).toBeInTheDocument();
    }

    // Note form: markdown filled but description empty → submit disabled.
    fireEvent.click(within(dialog).getByRole("radio", { name: "Note" }));
    const markdown = await within(dialog).findByLabelText("Markdown");
    fireEvent.change(markdown, { target: { value: "## Follow-ups" } });
    const attach = within(dialog).getByRole("button", { name: "Attach" });
    expect(attach).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Description"), {
      target: { value: "Follow-up items from the review." },
    });
    expect(attach).not.toBeDisabled();
  });

  it("adds a note to a closed ticket and shows the new entry", async () => {
    await AllKinds.run();
    fireEvent.click(await screen.findByRole("button", { name: "Add context" }));

    const dialog = await screen.findByRole("dialog", { name: "Add context" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Note" }));
    fireEvent.change(await within(dialog).findByLabelText("Markdown"), {
      target: { value: "## Follow-ups\n- verify SSE" },
    });
    fireEvent.change(within(dialog).getByLabelText("Description"), {
      target: { value: "Follow-up items from the review." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Attach" }));

    expect(
      await screen.findByRole("listitem", {
        name: "Follow-up items from the review.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Add context" }),
    ).not.toBeInTheDocument();
  });

  it("edits a note's description and markdown from the entry", async () => {
    await AllKinds.run();
    const entry = await findEntry(NOTE_DESCRIPTION);
    fireEvent.click(within(entry).getByRole("button", { name: "Edit" }));

    const description = await within(entry).findByLabelText("Description");
    expect(description).toHaveValue(NOTE_DESCRIPTION);
    expect(description).toBeRequired();
    fireEvent.change(description, {
      target: { value: "Maintainer constraints (updated)." },
    });

    const markdown = within(entry).getByLabelText("Markdown");
    expect(markdown).toBeRequired();
    fireEvent.change(markdown, {
      target: { value: "## Constraints\n- keyboard nav stays" },
    });

    // Clearing the description disables Save (required everywhere).
    fireEvent.change(description, { target: { value: "  " } });
    expect(within(entry).getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(description, {
      target: { value: "Maintainer constraints (updated)." },
    });

    fireEvent.click(within(entry).getByRole("button", { name: "Save" }));
    const updatedEntry = await screen.findByRole("listitem", {
      name: "Maintainer constraints (updated).",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(updatedEntry).getByRole("button", { name: "Edit" }),
      ),
    );
  });

  it("returns focus to the attachment Edit button after cancelling an edit", async () => {
    await AllKinds.run();
    const entry = await findEntry(NOTE_DESCRIPTION);
    const edit = within(entry).getByRole("button", { name: "Edit" });

    fireEvent.click(edit);
    fireEvent.click(
      await within(entry).findByRole("button", { name: "Cancel" }),
    );

    await waitFor(() => expect(document.activeElement).toBe(edit));
  });

  it("confirms before removing an attachment optimistically", async () => {
    await AllKinds.run();
    const entry = await findEntry(FILE_DESCRIPTION);
    fireEvent.click(within(entry).getByRole("button", { name: "Remove" }));

    const firstConfirmation = await screen.findByRole("alertdialog", {
      name: "Remove attachment?",
    });
    expect(entry).toBeInTheDocument();
    fireEvent.click(
      within(firstConfirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(entry).toBeInTheDocument();

    fireEvent.click(within(entry).getByRole("button", { name: "Remove" }));
    const confirmation = await screen.findByRole("alertdialog", {
      name: "Remove attachment?",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Remove" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("listitem", { name: FILE_DESCRIPTION }),
      ).not.toBeInTheDocument(),
    );
    const nextEntry = await findEntry(CONVERSATION_DESCRIPTION);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(nextEntry).getByRole("button", { name: "View" }),
      ),
    );
  });

  it("FailedFileUpload leaves no phantom entry and retries from the red panel", async () => {
    await FailedFileUpload.run();

    // The failed upload is a red panel, not an attachment entry.
    const panel = await screen.findByRole("alert");
    expect(panel).toHaveTextContent(/Couldn't attach trace\.json/);
    expect(panel).toBeInTheDocument();
    expect(
      screen.queryByRole("listitem", {
        name: "Startup profile trace from the slow dossier.",
      }),
    ).not.toBeInTheDocument();

    // Retry re-issues the upload; the second attempt succeeds and the real
    // entry replaces the panel.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("listitem", {
        name: "Startup profile trace from the slow dossier.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/Couldn't attach trace\.json/),
    ).not.toBeInTheDocument();
  });

  it("FailedFileUpload discards the failed upload without persisting anything", async () => {
    await FailedFileUpload.run();

    await screen.findByText(/Couldn't attach trace\.json/);
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() =>
      expect(
        screen.queryByText(/Couldn't attach trace\.json/),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("listitem", {
        name: "Startup profile trace from the slow dossier.",
      }),
    ).not.toBeInTheDocument();
  });

  it("settles every pending row when overlapping file uploads complete", async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{
      description: string;
      file: File;
      resolve(response: Response): void;
    }> = [];
    globalThis.fetch = async (_input, init) => {
      if (init?.method !== "POST" || !(init.body instanceof FormData)) {
        throw new Error("Unexpected request in concurrent upload test");
      }
      const metadata = JSON.parse(String(init.body.get("metadata"))) as {
        description: string;
      };
      const file = init.body.get("file");
      if (!(file instanceof File)) throw new Error("Expected an uploaded file");
      return await new Promise<Response>((resolve) => {
        requests.push({ description: metadata.description, file, resolve });
      });
    };

    try {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, refetchInterval: false } },
      });
      const rendered = render(
        <QueryClientProvider client={queryClient}>
          <AttachmentIndex
            projectName="command-center"
            number={12}
            attachments={[]}
          />
        </QueryClientProvider>,
      );
      const index = within(rendered.container);

      const submitFile = async (fileName: string, description: string) => {
        fireEvent.click(index.getByRole("button", { name: "Add context" }));
        const dialog = await screen.findByRole("dialog", {
          name: "Add context",
        });
        fireEvent.change(within(dialog).getByLabelText("File"), {
          target: {
            files: [new File([fileName], fileName, { type: "text/plain" })],
          },
        });
        fireEvent.change(within(dialog).getByLabelText("Description"), {
          target: { value: description },
        });
        fireEvent.click(within(dialog).getByRole("button", { name: "Attach" }));
        await index.findByRole("listitem", {
          name: `Uploading ${fileName}`,
        });
      };

      await submitFile("first.txt", "First concurrent upload.");
      await submitFile("second.txt", "Second concurrent upload.");
      await waitFor(() => expect(requests).toHaveLength(2));

      const settle = async (index: number) => {
        const request = requests[index]!;
        await act(async () => {
          request.resolve(
            Response.json(
              {
                id: `att-concurrent-${index}`,
                ticketId: "ticket-12",
                description: request.description,
                payload: {
                  kind: "file",
                  fileName: request.file.name,
                  snapshotKey: `ticket-content/concurrent/${request.file.name}`,
                  mediaType: request.file.type,
                  sizeBytes: request.file.size,
                  sha256: `sha-${index}`,
                },
                createdAt: "2026-07-11T12:00:00.000Z",
                updatedAt: "2026-07-11T12:00:00.000Z",
              },
              { status: 201 },
            ),
          );
          await Promise.resolve();
        });
      };

      await settle(0);
      await settle(1);

      await waitFor(() => {
        expect(
          index.queryByRole("listitem", { name: "Uploading first.txt" }),
        ).not.toBeInTheDocument();
        expect(
          index.queryByRole("listitem", { name: "Uploading second.txt" }),
        ).not.toBeInTheDocument();
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
