// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentBackendId } from "@/lib/shared/schemas";
import BackendToggle from "./BackendToggle";

afterEach(cleanup);

function renderToggle(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

describe("BackendToggle", () => {
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
});
