// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TicketDetail } from "@/lib/tickets/schemas";
import { TicketDescriptionEditor, TicketTitleEditor } from "./TicketEditor";

const DETAIL: TicketDetail = {
  id: "ticket-1",
  projectPath: "/repos/alpha",
  projectName: "alpha",
  number: 1,
  title: "Original",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  attachments: [],
  sessions: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TicketTitleEditor mutation feedback", () => {
  it("retains the first failure when a second save is queued", async () => {
    const patchResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") throw new Error("Unexpected request");
      return new Promise<Response>((resolve) => patchResolvers.push(resolve));
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <TicketTitleEditor projectName="alpha" number={1} title="Original" />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    const saveTitle = async (title: string) => {
      await user.click(screen.getByRole("heading", { name: "Original" }));
      const input = screen.getByRole("textbox", { name: "Ticket title" });
      await user.clear(input);
      await user.type(input, title);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("heading", { name: "Original" });
    };
    await saveTitle("First save");
    await saveTitle("Second save");
    await waitFor(() => expect(patchResolvers).toHaveLength(1));

    await act(async () => {
      patchResolvers[0]!(
        Response.json({ error: "first failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(patchResolvers).toHaveLength(2));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");

    await act(async () => {
      patchResolvers[1]!(
        Response.json({
          ...DETAIL,
          title: "Second save",
          updatedAt: "2026-07-01T00:00:01.000Z",
        }),
      );
      await Promise.resolve();
    });
  });
});

function renderDescriptionEditor(description: string) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <TicketDescriptionEditor
        projectName="alpha"
        number={1}
        description={description}
      />
    </QueryClientProvider>,
  );
}

describe("TicketDescriptionEditor preview", () => {
  it("renders the description through the canonical document adapter", async () => {
    renderDescriptionEditor("## Rollout plan\n\nShip the migration.");

    const heading = await screen.findByRole("heading", {
      name: "Rollout plan",
    });
    expect(heading.tagName).toBe("H2");
    // DocumentMarkdown stamps a document-intent root; this pins that the host
    // renders through the canonical document adapter.
    expect(heading.closest("[data-markdown-intent='document']")).not.toBeNull();
    // Raw markdown markers must not leak into the rendered output.
    expect(screen.queryByText(/## Rollout plan/)).not.toBeInTheDocument();
  });

  it("swaps the preview for a textarea on Edit and restores it on Cancel", async () => {
    renderDescriptionEditor("## Rollout plan\n\nShip the migration.");
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Rollout plan" });
    await user.click(screen.getByRole("button", { name: "Edit" }));

    const textarea = screen.getByRole("textbox", {
      name: "Ticket description",
    });
    expect(textarea).toHaveValue("## Rollout plan\n\nShip the migration.");
    expect(
      screen.queryByRole("heading", { name: "Rollout plan" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(
      await screen.findByRole("heading", { name: "Rollout plan" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Ticket description" }),
    ).not.toBeInTheDocument();
  });

  it("persists an edited description through the update mutation on Save", async () => {
    const patchBodies: string[] = [];
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") throw new Error("Unexpected request");
      patchBodies.push(String(init.body));
      return Promise.resolve(
        Response.json({ ...DETAIL, description: "Rewritten." }),
      );
    });
    renderDescriptionEditor("## Rollout plan\n\nShip the migration.");
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: "Rollout plan" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const textarea = screen.getByRole("textbox", {
      name: "Ticket description",
    });
    await user.clear(textarea);
    await user.type(textarea, "Rewritten.");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toContain("Rewritten.");
    expect(
      screen.queryByRole("textbox", { name: "Ticket description" }),
    ).not.toBeInTheDocument();
  });
});
