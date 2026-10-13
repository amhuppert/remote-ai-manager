// @vitest-environment jsdom
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSummary } from "@/components/runs/model";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { SessionRuns } from "./SessionRuns";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const routerPush = vi.hoisted(() => vi.fn<(href: string) => void>());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), back: vi.fn() }),
}));

const run: RunSummary = {
  runId: "run-a",
  title: "Checkout v2 rollout",
  kind: "workflow",
  status: { kind: "running" },
  attention: 0,
  contexts: { done: 1, total: 3 },
  costUsd: 1.5,
  costComplete: true,
  startedAt: "2026-10-09T10:00:00.000Z",
  finishedAt: null,
  owner: { conversationId: "owner-1", title: null, backend: "claude" },
};

let listed: Response;

beforeEach(() => {
  listed = new Response(JSON.stringify([run]), {
    headers: { "Content-Type": "application/json" },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => listed),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("the session's runs on its overview", () => {
  it("leads to the run page at the run chosen, or at the session's runs", async () => {
    renderWithQuery(
      <SessionRuns projectName="plc" sessionName="fx" />,
      createTestQueryClient(),
    );

    expect(
      await screen.findByRole("link", { name: /Checkout v2 rollout/ }),
    ).toHaveAttribute("href", "/projects/plc/fx/runs?run=run-a");
    expect(screen.getByRole("link", { name: "Open runs" })).toHaveAttribute(
      "href",
      "/projects/plc/fx/runs",
    );
  });

  it("leads to the session's run templates", async () => {
    const user = userEvent.setup();
    renderWithQuery(
      <SessionRuns projectName="plc" sessionName="fx" />,
      createTestQueryClient(),
    );

    await user.click(
      await screen.findByRole("button", { name: "Browse templates" }),
    );
    expect(routerPush).toHaveBeenCalledWith("/projects/plc/fx/runs/templates");
  });

  it("says when the runs could not be read, and shows a retry reading until the runs arrive", async () => {
    const user = userEvent.setup();
    let answer: (response: Response) => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: "Boom" }), { status: 500 }),
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              answer = resolve;
            }),
        ),
    );
    renderWithQuery(
      <SessionRuns projectName="plc" sessionName="fx" />,
      createTestQueryClient(),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load runs.",
    );
    const retry = screen.getByRole("button", { name: "Try again" });
    await user.click(retry);

    await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));

    answer(
      new Response(JSON.stringify([run]), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(await screen.findByText("Checkout v2 rollout")).toBeInTheDocument();
  });
});
