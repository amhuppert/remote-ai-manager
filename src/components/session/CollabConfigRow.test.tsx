// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CollabConfigRow, {
  type CollabConfigRowProps,
} from "@/components/session/CollabConfigRow";
import {
  getStaticBackendModelCatalog,
  listBackendCatalogEntries,
  type BackendSelectionDefaultsById,
} from "@/lib/agent-backends/catalog";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";

const CLAUDE_CATALOG = getStaticBackendModelCatalog("claude");
const CODEX_CATALOG = getStaticBackendModelCatalog("codex");
const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: defaultSelectionForModel(CLAUDE_CATALOG, "opus"),
  codex: defaultSelectionForModel(CODEX_CATALOG, "gpt-5.4"),
  cursor: { modelId: "composer-2.5", parameters: {} },
};
const MODEL_CATALOGS = { claude: CLAUDE_CATALOG, codex: CODEX_CATALOG };

function renderRow(overrides: Partial<CollabConfigRowProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  queryClient.setQueryData(
    backendCatalogKeys.catalog(),
    listBackendCatalogEntries(),
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <CollabConfigRow
        originatingAgent="claude"
        config={{
          agentTwo: {
            backend: "codex",
            modelSelection: BACKEND_DEFAULTS.codex,
          },
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
        }}
        backendDefaults={BACKEND_DEFAULTS}
        modelCatalogs={MODEL_CATALOGS}
        onChange={vi.fn()}
        onDismiss={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

describe("CollabConfigRow", () => {
  it("renders autonomous threshold labels as the exact lowercase values", () => {
    renderRow();

    for (const label of ["none", "minor", "major", "blocking"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const label of ["None", "Minor", "Major", "Blocking"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });

  it("updates Agent Two's complete selection atomically", () => {
    const onChange = vi.fn();
    renderRow({ onChange });

    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: /GPT-5.6 Terra/ }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTwo: {
          backend: "codex",
          modelSelection: defaultSelectionForModel(
            CODEX_CATALOG,
            "gpt-5.6-terra",
          ),
        },
      }),
    );
  });

  it("mirrors Agent One's composer selection as a read-only summary", () => {
    renderRow({
      agentOne: {
        backend: "claude",
        modelSelection: {
          modelId: "fable",
          parameters: { effort: "max", thinking: "true" },
        },
      },
    });
    const summary = screen.getByTitle("Uses this conversation's settings");
    expect(summary.textContent).toContain("fable");
    expect(summary.textContent).toContain("effort=max");
    expect(summary.textContent).toContain("thinking=true");
  });

  // A non-Claude collaboration lane is dispatched as a task run
  // (collaboration/helpers.ts builds `kind: "task_run"` for it), so a backend
  // registering no task facet cannot take one. The refusal is therefore read
  // off the catalog's facet data, and names both the facet and the surface
  // (spec D13, R15.1).
  it("refuses a backend with no task facet and says why, naming the facet and the surface", () => {
    const onChange = vi.fn();
    renderRow({ onChange });

    const cursor = screen.getByRole("button", { name: /Cursor/ });
    expect(cursor).toHaveAttribute("aria-disabled", "true");
    const reason = cursor.getAttribute("title") ?? "";
    expect(reason).toMatch(/task/i);
    expect(reason).toMatch(/collaboration/i);

    cursor.click();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reseeds Agent Two's runtime from the new backend's defaults on backend switch", () => {
    const onChange = vi.fn();
    renderRow({
      onChange,
      config: {
        agentTwo: {
          backend: "codex",
          modelSelection: defaultSelectionForModel(
            CODEX_CATALOG,
            "gpt-5.6-sol",
          ),
          profile: "global:reviewer",
        },
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
      },
    });

    // Exact name: a refused option's accessible name carries its reason, which
    // names the backends collaboration DOES run.
    screen.getByRole("button", { name: "Claude" }).click();

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTwo: {
          backend: "claude",
          modelSelection: BACKEND_DEFAULTS.claude,
          // The profile is prompt identity, not runtime — it survives.
          profile: "global:reviewer",
        },
      }),
    );
  });
});
