// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { backendCatalogKeys } from "@/lib/agent-backends/query-keys";
import { listBackendCatalogEntries } from "@/lib/agent-backends/catalog";
import { ConfigAgentRuntimeRows } from "./AgentRuntimeRows";
import { IDENTITY_PROVENANCE } from "./row-provenance";

afterEach(cleanup);

it.each([false, true])(
  "discloses Cursor limits in compact configuration (disabled=%s)",
  (disabled) => {
    const client = createTestQueryClient();
    client.setQueryData(
      backendCatalogKeys.catalog(),
      listBackendCatalogEntries(),
    );
    renderWithQuery(
      <ConfigAgentRuntimeRows
        rowPrefix="implementer"
        value={{
          backend: "cursor",
          modelSelection: {
            modelId: "composer-2.5",
            parameters: { fast: "false" },
          },
        }}
        onChange={vi.fn()}
        provenance={IDENTITY_PROVENANCE}
        disabled={disabled}
      />,
      client,
    );
    expect(screen.getAllByRole("note")).toHaveLength(1);
    expect(screen.getByRole("note")).toHaveTextContent(
      "Read-only and file ownership limits rely on instructions.",
    );
    expect(screen.queryByRole("checkbox")).toBeNull();
    if (!disabled)
      expect(
        screen.getByRole("button", { name: "Cursor" }),
      ).not.toHaveAttribute("aria-disabled", "true");
  },
);
