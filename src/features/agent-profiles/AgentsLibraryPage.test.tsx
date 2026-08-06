// @vitest-environment jsdom
/**
 * R10.2 — the management surface: scoped tabs with tier badges, editor
 * validation surfacing schema errors, the composed-prompt preview,
 * duplicate-to-scope, and the confirm-gated delete flow.
 *
 * Driven through the production query hooks and the real HTTP surface (a
 * stubbed `fetch` answering the documented routes), so each assertion covers
 * the request the page actually issues rather than a hand-wired callback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PROFILE_BLOCK_BEGIN } from "@/lib/agent-profiles/block";
import type {
  AgentProfileDeletionReport,
  AgentProfileLibraryEntry,
  AgentProfileLibraryListing,
} from "@/lib/agent-profiles/schemas";

import AgentsLibraryPage from "./AgentsLibraryPage";

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
      ref: { tier: "global", id: "security-reviewer" },
      name: "Security Reviewer",
      description: "Reads a diff for exploitable defects.",
      revision: 2,
      recommendedFor: ["workflow_validator"],
      tags: ["security"],
      readOnly: false,
    },
    {
      ref: { tier: "project", id: "house-style" },
      name: "House Style",
      description: "Writes the way this repo writes.",
      revision: 5,
      recommendedFor: ["conversation"],
      tags: ["style"],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

const HOUSE_STYLE_ENTRY: AgentProfileLibraryEntry = {
  tier: "project",
  readOnly: false,
  id: "house-style",
  revision: 5,
  name: "House Style",
  description: "Writes the way this repo writes.",
  instructions: "Prefer small, focused changes.",
  recommendedFor: ["conversation"],
  tags: ["style"],
};

/**
 * One holder of each kind R15.1 names — a project definition, a global
 * template, and the global defaults — plus a dormant one, so the dialog is
 * asserted against the full enumeration rather than a single happy row. The
 * same payload answers the delete, which is the contract: preview and report
 * are one shape from one reporter.
 */
const DELETION_PREVIEW: AgentProfileDeletionReport = {
  ref: { tier: "project", id: "house-style" },
  deletedRevision: 5,
  conversationSnapshotsExempt: true,
  savedReferenceEnumeration: {
    definitions: [
      {
        scope: { kind: "project", projectPath: "/repos/my-app" },
        id: "wf-1",
        name: "Nightly Delivery",
        contextId: "context-implement",
        dormant: false,
      },
      {
        scope: { kind: "project", projectPath: "/repos/my-app" },
        id: "wf-2",
        name: "Paused Review",
        contextId: "context-verify",
        dormant: true,
      },
    ],
    templates: [
      {
        scope: { kind: "global" },
        id: "tpl-1",
        name: "Shared Delivery Template",
        dormant: false,
      },
    ],
    workflowDefaults: true,
  },
};

interface RecordedRequest {
  method: string;
  url: string;
  body: unknown;
}

let requests: RecordedRequest[] = [];

/**
 * How the preview endpoint answers. Overridden per test to hold the response
 * open, because the gap this guards is a RACE: the dialog is on screen before
 * the scan returns, and that window is exactly when a too-fast human can
 * confirm a deletion they were never shown the consequences of.
 */
let respondToPreview: () => Promise<Response> = async () =>
  Response.json(DELETION_PREVIEW);

/** A promise plus its resolver, so a test can decide when the scan lands. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function stubApi(): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        method,
        url,
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });

      if (method === "GET" && url.endsWith("/agent-profiles")) {
        return Response.json(LISTING);
      }
      if (
        method === "GET" &&
        url.endsWith("/agent-profiles/project/house-style")
      ) {
        return Response.json(HOUSE_STYLE_ENTRY);
      }
      if (method === "POST" && url.endsWith("/agent-profiles/duplicate")) {
        return Response.json(
          {
            ref: { tier: "project", id: "security-reviewer" },
            name: "Security Reviewer",
            description: "Reads a diff for exploitable defects.",
            revision: 1,
            recommendedFor: ["workflow_validator"],
            tags: ["security"],
            readOnly: false,
          },
          { status: 201 },
        );
      }
      if (method === "GET" && url.endsWith("/deletion-preview")) {
        return respondToPreview();
      }
      if (method === "DELETE") {
        return Response.json(DELETION_PREVIEW);
      }
      return Response.json(
        { error: `unstubbed ${method} ${url}` },
        { status: 500 },
      );
    },
  );
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AgentsLibraryPage projectName={PROJECT} />
    </QueryClientProvider>,
  );
}

async function openHouseStyleEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("tab", { name: "Project" }));
  await user.click(
    await screen.findByRole("button", { name: "Edit House Style" }),
  );
  // The editor loads the record's instructions through the authorized get.
  await screen.findByDisplayValue("Prefer small, focused changes.");
}

beforeEach(() => {
  requests = [];
  respondToPreview = async () => Response.json(DELETION_PREVIEW);
  stubApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentsLibraryPage", () => {
  it("lists each scope behind its own tab, badged with its tier", async () => {
    const user = userEvent.setup();
    renderPage();

    // Built-ins first: a read-only scope is still a scope, and it is where a
    // duplicate-to-edit starts.
    const builtinRow = await screen.findByRole("button", {
      name: "Edit Standard Agent",
    });
    expect(within(builtinRow).getByText("Built-in")).toBeVisible();
    expect(within(builtinRow).getByText("Read-only")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit House Style" }),
    ).toBeNull();

    await user.click(screen.getByRole("tab", { name: "Global" }));
    const globalRow = await screen.findByRole("button", {
      name: "Edit Security Reviewer",
    });
    expect(within(globalRow).getByText("Global")).toBeVisible();

    await user.click(screen.getByRole("tab", { name: "Project" }));
    const projectRow = await screen.findByRole("button", {
      name: "Edit House Style",
    });
    expect(within(projectRow).getByText("Project")).toBeVisible();
  });

  it("surfaces the schema's own validation errors and refuses to save through them", async () => {
    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);

    await user.clear(screen.getByLabelText("Name"));

    expect(await screen.findByText(/too small|expected string/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // The containment rule the composer owns is enforced at authoring time too.
    await user.type(screen.getByLabelText("Name"), "House Style");
    const instructions = screen.getByLabelText("Instructions");
    await user.clear(instructions);
    await user.type(instructions, "Use ```ts fences");
    expect(await screen.findByText(/reserved sequence/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("previews the composed prompt the profile will be delivered as", async () => {
    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);

    const preview = await screen.findByLabelText("Composed prompt preview");
    // The real composer's frame, not a paraphrase of it — including the
    // qualified identity and the delimiters that contain the instructions.
    expect(preview).toHaveTextContent(
      "Profile: House Style (project:house-style, revision 6)",
    );
    expect(preview.textContent).toContain(PROFILE_BLOCK_BEGIN);
    expect(preview.textContent).toContain("Prefer small, focused changes.");
    expect(preview.textContent).toContain(
      "This agent profile — a subordinate specialization lens",
    );
  });

  it("duplicates a profile into another scope", async () => {
    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);

    await user.click(
      screen.getByRole("button", { name: "Duplicate to global" }),
    );

    await waitFor(() =>
      expect(
        requests.find((request) =>
          request.url.endsWith("/agent-profiles/duplicate"),
        ),
      ).toBeDefined(),
    );
    expect(
      requests.find((request) =>
        request.url.endsWith("/agent-profiles/duplicate"),
      )?.body,
    ).toEqual({
      source: { tier: "project", id: "house-style" },
      targetTier: "global",
    });
  });

  it("gates delete behind a confirmation and sends the confirmed revision", async () => {
    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    // Nothing is sent by opening the confirmation — the dialog IS the confirm.
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete House Style?",
    });
    expect(confirmation).toHaveTextContent(/keep their own\s+snapshot/);

    // Confirmation is reachable only once the preview has been shown.
    const confirm = within(confirmation).getByRole("button", {
      name: "Delete profile",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);

    await waitFor(() =>
      expect(
        requests.find((request) => request.method === "DELETE"),
      ).toBeDefined(),
    );
    const deletion = requests.find((request) => request.method === "DELETE");
    expect(deletion?.url).toContain("/agent-profiles/project/house-style");
    expect(deletion?.body).toEqual({ expectedRevision: 5, confirm: true });
  });

  it("queries the deletion preview when the dialog opens and lists every holder before confirmation (R15.1)", async () => {
    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);

    // Not asked for until the human opens the dialog: the scan is per open.
    expect(
      requests.some((request) => request.url.endsWith("/deletion-preview")),
    ).toBe(false);

    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(
        requests.find((request) => request.url.endsWith("/deletion-preview")),
      ).toBeDefined(),
    );
    const preview = requests.find((request) =>
      request.url.endsWith("/deletion-preview"),
    );
    expect(preview?.method).toBe("GET");
    expect(preview?.url).toContain("/agent-profiles/project/house-style/");

    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete House Style?",
    });
    const holders = await within(confirmation).findByRole("list", {
      name: "Workflows referencing this profile",
    });
    expect(holders).toHaveTextContent("Nightly Delivery");
    expect(holders).toHaveTextContent("Shared Delivery Template");
    // The dormant holder is listed and MARKED, not silently folded in.
    const dormantRow = within(holders).getByText("Paused Review").closest("li");
    expect(dormantRow).not.toBeNull();
    expect(dormantRow).toHaveTextContent("Dormant");
    expect(confirmation).toHaveTextContent(
      "The global workflow defaults also reference it.",
    );

    // Advisory about its CONTENT: holders were found and the button is still
    // live, because a human may delete a referenced profile on purpose.
    expect(
      within(confirmation).getByRole("button", { name: "Delete profile" }),
    ).toBeEnabled();
  });

  /**
   * Advisory means the enumeration cannot VETO a deletion. It does not mean the
   * enumeration is optional: R15.1 puts the holders on screen "before
   * confirmation", and a dialog that accepts a confirmation while the scan is
   * still in flight has shown the human nothing.
   */
  it("refuses confirmation until the preview has actually been shown (R15.1)", async () => {
    const scan = deferred<Response>();
    respondToPreview = () => scan.promise;

    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const confirmation = await screen.findByRole("alertdialog", {
      name: "Delete House Style?",
    });
    const confirm = within(confirmation).getByRole("button", {
      name: "Delete profile",
    });

    // The dialog is open and the scan has not landed: confirming here would
    // delete without ever showing a holder.
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);

    scan.resolve(Response.json(DELETION_PREVIEW));

    await within(confirmation).findByRole("list", {
      name: "Workflows referencing this profile",
    });
    await waitFor(() => expect(confirm).toBeEnabled());
    await user.click(confirm);
    await waitFor(() =>
      expect(
        requests.find((request) => request.method === "DELETE"),
      ).toBeDefined(),
    );
  });

  /**
   * A failed scan keeps the button shut, which is not merely cautious — the
   * server's own delete runs the SAME enumeration before removing anything and
   * refuses when it throws. An enabled button here would promise an outcome the
   * backend would not honour.
   */
  it("keeps confirmation shut and says why when the preview fails (R15.1)", async () => {
    respondToPreview = async () =>
      Response.json({ error: "reference scan failed" }, { status: 500 });

    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    const confirmation = await screen.findByRole("alertdialog", {
      name: "Delete House Style?",
    });
    await within(confirmation).findByRole("alert");
    expect(confirmation).toHaveTextContent(
      /Could not check which workflows reference this profile/,
    );

    const confirm = within(confirmation).getByRole("button", {
      name: "Delete profile",
    });
    expect(confirm).toBeDisabled();
    await user.click(confirm);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  /**
   * The nastiest shape of the same gap: a preview that ALREADY succeeded once.
   * The query cache keeps that first report, so a later reopen whose refetch
   * fails lands in a state carrying BOTH stale data and a fresh error. Showing
   * the error while treating the retained report as "a preview was shown" would
   * re-open the button over an enumeration nobody is looking at — and one that
   * may no longer be true, which is worse than never having scanned.
   */
  it("keeps confirmation shut when a reopen's refetch fails after an earlier success (R15.1)", async () => {
    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);

    // First open succeeds: holders on screen, button live.
    await user.click(screen.getByRole("button", { name: "Delete" }));
    const firstOpen = await screen.findByRole("alertdialog", {
      name: "Delete House Style?",
    });
    await within(firstOpen).findByRole("list", {
      name: "Workflows referencing this profile",
    });
    await waitFor(() =>
      expect(
        within(firstOpen).getByRole("button", { name: "Delete profile" }),
      ).toBeEnabled(),
    );

    await user.click(within(firstOpen).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Delete House Style?" }),
      ).toBeNull(),
    );

    // The scan now fails, while the successful first report is still cached.
    respondToPreview = async () =>
      Response.json({ error: "reference scan failed" }, { status: 500 });

    await user.click(screen.getByRole("button", { name: "Delete" }));
    const reopened = await screen.findByRole("alertdialog", {
      name: "Delete House Style?",
    });
    await within(reopened).findByRole("alert");

    const confirm = within(reopened).getByRole("button", {
      name: "Delete profile",
    });
    // The stale enumeration is neither shown nor counted as having been shown.
    expect(
      within(reopened).queryByRole("list", {
        name: "Workflows referencing this profile",
      }),
    ).toBeNull();
    await waitFor(() => expect(confirm).toBeDisabled());
    await user.click(confirm);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("abandons a delete when the confirmation is dismissed", async () => {
    const user = userEvent.setup();
    renderPage();
    await openHouseStyleEditor(user);

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: "Delete House Style?" }),
      ).getByRole("button", { name: "Cancel" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("alertdialog", { name: "Delete House Style?" }),
      ).toBeNull(),
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("offers no save control for a read-only built-in", async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(
      await screen.findByRole("button", { name: "Edit Standard Agent" }),
    );

    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
    expect(screen.getByText(/Built-in profiles are read-only/i)).toBeVisible();
  });
});
