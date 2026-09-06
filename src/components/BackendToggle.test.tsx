// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  listBackendCatalogEntries,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import BackendToggle from "./BackendToggle";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";

afterEach(cleanup);

function renderToggle(ui: React.ReactElement, fetched = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (fetched)
    client.setQueryData(
      backendCatalogKeys.catalog(),
      listBackendCatalogEntries(),
    );
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("BackendToggle", () => {
  it("does not authorize a gated choice from the hydration seed", () => {
    const onChange = vi.fn();
    renderToggle(
      <BackendToggle
        value="claude"
        onChange={onChange}
        disabledReason={() => null}
      />,
      false,
    );
    const codex = screen.getByRole("button", { name: /Codex/ });
    expect(codex).toHaveAttribute("aria-disabled", "true");
    expect(codex).toHaveAccessibleName(/loading or unavailable/);
    codex.click();
    expect(onChange).not.toHaveBeenCalled();
  });
  it("offers every cataloged backend by label and reports selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderToggle(<BackendToggle value="claude" onChange={onChange} />);

    await user.click(screen.getByRole("button", { name: "Codex" }));
    expect(onChange).toHaveBeenCalledWith("codex");
  });

  it("renders the catalog label in read-only mode", () => {
    renderToggle(<BackendToggle value="codex" onChange={vi.fn()} readOnly />);
    const badge = screen.getByText("Codex");
    expect(badge.hasAttribute("data-backend-unknown")).toBe(false);
  });

  it("flags an unknown backend id in read-only mode instead of silently showing the raw id", () => {
    renderToggle(
      <BackendToggle
        value={"mystery" as AgentBackendId}
        onChange={vi.fn()}
        readOnly
      />,
    );
    const badge = screen.getByTitle(/unknown agent backend/i);
    expect(badge.getAttribute("data-backend-unknown")).toBe("true");
    expect(badge.textContent).toContain("mystery");
  });

  it("renders a cataloged backend as its label rather than the unknown-backend badge", () => {
    renderToggle(<BackendToggle value="cursor" onChange={vi.fn()} readOnly />);
    const badge = screen.getByText("Cursor");
    expect(badge.hasAttribute("data-backend-unknown")).toBe(false);
  });

  // The active-state accent is a closed allowlist of `data-tone` variants —
  // Tailwind cannot generate a class from a runtime token. A registered tone
  // missing from it renders the active option unstyled, so the allowlist is
  // asserted against the catalog rather than against a hand-listed set.
  it("carries an active-state accent class for every tone token the catalog declares", () => {
    renderToggle(<BackendToggle value="cursor" onChange={vi.fn()} />);

    for (const entry of listBackendCatalogEntries()) {
      const button = screen.getByRole("button", { name: entry.label });
      expect(button.getAttribute("data-tone")).toBe(entry.toneToken);
      expect(button.className).toContain(
        `data-[active=true]:data-[tone=${entry.toneToken}]:bg-${entry.toneToken}-glow`,
      );
      expect(button.className).toContain(
        `data-[active=true]:data-[tone=${entry.toneToken}]:text-${entry.toneToken}`,
      );
    }
  });

  describe("per-option disabled reasons", () => {
    const refuseCursor = (entry: BackendCatalogEntry) =>
      entry.id === "cursor" ? "Cursor does not support tasks" : null;

    it("marks the refused option disabled with its reason and does not select it", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderToggle(
        <BackendToggle
          value="claude"
          onChange={onChange}
          disabledReason={refuseCursor}
        />,
      );

      const cursor = screen.getByRole("button", { name: /Cursor/ });
      expect(cursor.getAttribute("aria-disabled")).toBe("true");
      expect(cursor.getAttribute("title")).toContain(
        "Cursor does not support tasks",
      );
      expect(cursor.getAttribute("aria-label")).toContain(
        "Cursor does not support tasks",
      );

      await user.click(cursor);
      expect(onChange).not.toHaveBeenCalled();
    });

    it("leaves options without a reason selectable", async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      renderToggle(
        <BackendToggle
          value="claude"
          onChange={onChange}
          disabledReason={refuseCursor}
        />,
      );

      const codex = screen.getByRole("button", { name: "Codex" });
      expect(codex.hasAttribute("aria-disabled")).toBe(false);

      await user.click(codex);
      expect(onChange).toHaveBeenCalledWith("codex");
    });
  });
});
