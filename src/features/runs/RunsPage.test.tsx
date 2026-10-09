// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { checkoutRun, sessionRuns } from "./fixtures";
import RunsPage from "./RunsPage";

const routerPush = vi.fn();
const routerReplace = vi.fn();
const urlSubscribers = new Set<() => void>();
let urlVersion = 0;

function navigateInPlace(href: string): void {
  window.history.pushState({}, "", href);
  urlVersion += 1;
  for (const notify of [...urlSubscribers]) notify();
}

function useFakeSearchParams(): URLSearchParams {
  useSyncExternalStore(
    (notify) => {
      urlSubscribers.add(notify);
      return () => {
        urlSubscribers.delete(notify);
      };
    },
    () => urlVersion,
    () => urlVersion,
  );
  return new URLSearchParams(window.location.search);
}

vi.mock("next/navigation", () => ({
  useParams: () => ({ name: "plc", session: "fx" }),
  useRouter: () => ({
    push: routerPush,
    replace: (href: string) => {
      routerReplace(href);
      navigateInPlace(href);
    },
  }),
  useSearchParams: () => useFakeSearchParams(),
}));

const base = "/api/projects/plc/sessions/fx/runs";
const posted: Array<{ url: string; body: unknown }> = [];
let listed = sessionRuns;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  posted.length = 0;
  listed = sessionRuns;
  routerReplace.mockReset();
  navigateInPlace("/projects/plc/fx/runs");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        posted.push({
          url,
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        });
        return url.endsWith("/control")
          ? json({ ok: true, progress: { kind: "paused", draining: true } })
          : json({ ok: true });
      }
      if (url === base) return json(listed);
      if (url === `${base}/${checkoutRun.runId}/page`) return json(checkoutRun);
      return json({ error: "Not found" }, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderPage() {
  const queryClient = createTestQueryClient();
  renderWithQuery(<RunsPage />, queryClient);
  return { queryClient };
}

describe("runs page", () => {
  it("opens the session's current run and sends a person's pause to it", async () => {
    const user = userEvent.setup();
    renderPage();

    expect(
      await screen.findByRole("heading", { name: checkoutRun.title }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(posted).toEqual([
        {
          url: `${base}/${checkoutRun.runId}/control`,
          body: { action: "pause" },
        },
      ]),
    );
  });

  it("approves a result for the started Context its context key names", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("heading", { name: checkoutRun.title });

    await user.click(screen.getByRole("button", { name: "Review" }));
    await user.click(await screen.findByRole("button", { name: "Approve" }));

    const ui = checkoutRun.contexts.find((context) => context.key === "ui");
    await waitFor(() =>
      expect(posted).toEqual([
        {
          url: `${base}/${checkoutRun.runId}/decide`,
          body: {
            contextId: ui?.invocationId,
            candidateId: ui?.approval?.candidateId,
            decision: "approved",
          },
        },
      ]),
    );
  });

  it("keeps the run it opened on when a newer run starts: the opening choice is put in the address", async () => {
    const { queryClient } = renderPage();
    await screen.findByRole("heading", { name: checkoutRun.title });
    expect(routerReplace).toHaveBeenCalledWith(
      `/projects/plc/fx/runs?run=${encodeURIComponent(checkoutRun.runId)}`,
    );

    const [current] = sessionRuns;
    if (current === undefined) throw new Error("no run fixture");
    const newer = { ...current, runId: "run-newer", title: "Newer run" };
    listed = [newer, ...sessionRuns];
    await act(() => queryClient.invalidateQueries());

    expect(await screen.findByText("Newer run")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: checkoutRun.title }),
    ).toBeInTheDocument();
  });

  it("keeps the session's runs beside a run that cannot be read, to choose another", async () => {
    navigateInPlace("/projects/plc/fx/runs?run=run-gone");
    renderPage();

    expect(
      await screen.findByText("This run could not be loaded"),
    ).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Runs" })).toHaveTextContent(
      checkoutRun.title,
    );
  });
});
