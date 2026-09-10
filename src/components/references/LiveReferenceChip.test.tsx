// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { installFetchFixture } from "@/test/fetch-fixture";
import { LiveReferenceChip } from "./LiveReferenceChip";
import { liveReferenceQuery } from "@/lib/live-references/queries";
import type { LiveReferenceResult } from "@/lib/live-references/schemas";

const target = { kind: "ticket", projectName: "cc", id: "90" } as const;
const result: LiveReferenceResult = {
  target,
  checkedAt: "2026-09-10T04:00:00.000Z",
  unavailableReason: null,
  summary: {
    title: "Current ticket title",
    identity: "cc#90",
    status: "Done",
    tone: "green",
    href: "/tickets/cc/90",
    readCommand: "cctl ticket get 'cc#90'",
    attentionCount: 0,
    details: [{ label: "Project", value: "cc" }],
  },
};
let api: ReturnType<typeof installFetchFixture>;
let client: QueryClient;
beforeEach(() => {
  api = installFetchFixture();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  api.json("POST", "/api/live-references", { results: [result] });
});
afterEach(() => {
  cleanup();
  client.clear();
  api.restore();
});
function renderChip() {
  return render(
    <QueryClientProvider client={client}>
      <LiveReferenceChip
        target={target}
        title="Captured title"
        identity="cc#90"
        reference="original XML"
      />
      <input aria-label="Next field" />
    </QueryClientProvider>,
  );
}

describe("live reference chip", () => {
  it("resolves current state and opens a keyboard-accessible preview without navigating", async () => {
    renderChip();
    expect(await screen.findByText("Current ticket title")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: /Current ticket title/ }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/tickets/cc/90",
    );
    expect(
      screen.getByRole("button", { name: "Copy reference" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Current ticket title/ }),
    ).toHaveFocus();
    await user.click(
      screen.getByRole("button", { name: /Current ticket title/ }),
    );
    await user.click(screen.getByRole("button", { name: "Copy reference" }));
    expect(await navigator.clipboard.readText()).toBe("original XML");
  });
  it("keeps last known state on a failed refresh, then recovers without editing the reference", async () => {
    renderChip();
    await screen.findByText("Current ticket title");
    api.reply("POST", "/api/live-references", {
      status: 503,
      json: { error: "Offline" },
    });
    await act(() => client.refetchQueries(liveReferenceQuery(target)));
    expect(await screen.findByText("Stale")).toBeInTheDocument();
    expect(screen.getByText("Current ticket title")).toBeInTheDocument();
    api.json("POST", "/api/live-references", {
      results: [
        { ...result, summary: { ...result.summary!, title: "Renamed ticket" } },
      ],
    });
    await act(() => client.refetchQueries(liveReferenceQuery(target)));
    expect(await screen.findByText("Renamed ticket")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
  });
  it("preserves a deleted reference with a copy action and no broken navigation", async () => {
    api.json("POST", "/api/live-references", {
      results: [{ ...result, summary: null, unavailableReason: "missing" }],
    });
    renderChip();
    await screen.findByText("Unavailable");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Captured title/ }));
    expect(
      screen.queryByRole("link", { name: "Open" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy reference" }));
    expect(await navigator.clipboard.readText()).toBe("original XML");
  });
  it("leaves focus on the chosen field when dismissing a pinned preview outside", async () => {
    renderChip();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Current ticket title/ }),
    );
    await user.click(screen.getByRole("textbox", { name: "Next field" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Next field" })).toHaveFocus();
  });
  it("shares one current-state read across repeated visible references", async () => {
    renderChip();
    renderChip();
    await waitFor(() =>
      expect(screen.getAllByText("Current ticket title")).toHaveLength(2),
    );
    expect(api.requestsTo("POST", "/api/live-references")).toHaveLength(1);
    expect(api.requestsTo("POST", "/api/live-references")[0]?.jsonBody).toEqual(
      { targets: [target] },
    );
  });
});
