// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TemplateSummary } from "../../template-model";
import { TemplateLibrary } from "./TemplateLibrary";

const templates: TemplateSummary[] = [
  { id: "review", name: "Release review", description: "Review release readiness across lanes.", tier: "project", contexts: 3, updatedAt: "2026-10-08T10:00:00Z" },
  { id: "review", name: "Release review", description: "Review a candidate with an independent agent.", tier: "global", contexts: 1, updatedAt: "2026-10-07T10:00:00Z" },
  { id: "docs", name: "Documentation audit", description: "Audit project guides and reference documents.", tier: "project", contexts: 2, updatedAt: "2026-10-06T10:00:00Z" },
];

describe("TemplateLibrary", () => {
  it("combines a name search with scope and preserves the selected template identity", () => {
    const onLaunch = vi.fn();
    const onConfigure = vi.fn();
    render(<TemplateLibrary templates={templates} onLaunch={onLaunch} onConfigure={onConfigure} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: " release " } });
    expect(screen.queryByRole("heading", { name: "Documentation audit" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Release review" })).toHaveLength(2);
    fireEvent.click(screen.getByRole("radio", { name: "Global" }));
    const card = screen.getByRole("article", { name: "Release review · Global" });
    expect(screen.getAllByRole("article")).toHaveLength(1);
    fireEvent.click(within(card).getByRole("button", { name: "Configure" }));
    fireEvent.click(within(card).getByRole("button", { name: "Launch" }));
    expect(onConfigure).toHaveBeenCalledWith(templates[1]);
    expect(onLaunch).toHaveBeenCalledWith(templates[1]);
  });

  it("recovers from filters matching nothing without losing the library", () => {
    render(<TemplateLibrary templates={templates} onLaunch={vi.fn()} onConfigure={vi.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), { target: { value: "missing" } });
    expect(screen.getByText("No matching templates")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("explains an empty library without offering an impossible launch", () => {
    render(<TemplateLibrary templates={[]} onLaunch={vi.fn()} onConfigure={vi.fn()} />);
    expect(screen.getByText("No saved templates")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Launch" })).toBeNull();
  });
});
