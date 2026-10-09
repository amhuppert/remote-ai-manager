// @vitest-environment jsdom
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunDetail, RunSummary } from "@/components/runs/model";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { OwnerRunCards } from "./OwnerRunCards";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const base = "/api/projects/plc/sessions/fx/runs";

function summary(
  runId: string,
  owner: string,
  finishedAt: string | null = null,
): RunSummary {
  return {
    runId,
    title: `Run ${runId}`,
    kind: "workflow",
    status: { kind: "needs_input" },
    attention: 2,
    contexts: { done: 1, total: 3 },
    costUsd: 1.5,
    costComplete: true,
    startedAt: "2026-10-09T10:00:00.000Z",
    finishedAt,
    owner: { conversationId: owner, title: null, backend: "claude" },
  };
}

const owned = summary("run-a", "owner-1");
const quiet: RunSummary = {
  ...summary("run-q", "owner-1"),
  status: { kind: "running" },
  attention: 0,
};
const page: RunDetail = {
  runId: "run-a",
  title: owned.title,
  kind: "workflow",
  status: { kind: "needs_input" },
  owner: owned.owner,
  definitionRevision: 1,
  startedAt: owned.startedAt,
  finishedAt: null,
  costUsd: 1.5,
  costComplete: true,
  attention: [
    {
      kind: "approval",
      contextKey: "ui",
      contextTitle: "Build the UI",
      requestedAt: "2026-10-09T10:05:00.000Z",
      reviewersPassed: 1,
    },
    { kind: "stalled", causes: ["effect-1"] },
  ],
  contexts: [],
  edges: [],
  lanes: [],
  loops: [],
  documents: [],
  documentHistory: [],
  charter: null,
  charterHistory: [],
  activity: [],
  definition: null,
};

const posted: Array<{ url: string; body: unknown }> = [];
let failing: { list: boolean; page: boolean } = { list: false, page: false };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  posted.length = 0;
  failing = { list: false, page: false };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posted.push({
          url,
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        });
        return json({ ok: true, progress: { kind: "running" } });
      }
      if (url === base && failing.list) return json({ error: "Boom" }, 500);
      if (url === `${base}/run-a/page` && failing.page)
        return json({ error: "Boom" }, 500);
      if (url === base)
        return json([
          quiet,
          owned,
          summary("run-b", "other-1"),
          summary("run-c", "owner-1", "2026-10-09T09:00:00.000Z"),
        ]);
      if (url === `${base}/run-a/page`) return json(page);
      return json({ error: "Not found" }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderCards() {
  renderWithQuery(
    <OwnerRunCards
      projectName="plc"
      sessionName="fx"
      conversationId="owner-1"
    />,
    createTestQueryClient(),
  );
}

describe("the runs a conversation owns, above its composer", () => {
  it("shows only the conversation's current runs, those that need the person first", async () => {
    renderCards();

    await screen.findByRole("article", { name: "Run: Run run-a" });
    expect(
      screen
        .getAllByRole("article")
        .map((card) => card.getAttribute("aria-label")),
    ).toEqual(["Run: Run run-a", "Run: Run run-q"]);
  });

  it("resumes the run in place for finished work nothing picked up", async () => {
    const user = userEvent.setup();
    renderCards();

    await user.click(await screen.findByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(posted).toEqual([
        { url: `${base}/run-a/control`, body: { action: "resume" } },
      ]),
    );
  });

  it("takes a decision to the run page, at the context that waits for it", async () => {
    renderCards();

    expect(await screen.findByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/projects/plc/fx/runs?run=run-a&context=ui",
    );
  });

  it("says when the conversation's runs could not be read, and reads them again", async () => {
    const user = userEvent.setup();
    failing.list = true;
    renderCards();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load this conversation's runs.",
    );
    failing.list = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      await screen.findByRole("article", { name: "Run: Run run-a" }),
    ).toBeInTheDocument();
  });

  it("keeps a run that needs the person in view when what it needs could not be read", async () => {
    failing.page = true;
    renderCards();

    const card = await screen.findByRole("article", { name: "Run: Run run-a" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(
      "Could not read what this run needs.",
    );
    expect(
      within(card).getByRole("link", { name: "Open run" }),
    ).toHaveAttribute("href", "/projects/plc/fx/runs?run=run-a");
  });
});
