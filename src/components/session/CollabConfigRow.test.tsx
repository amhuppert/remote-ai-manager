// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import CollabConfigRow, {
  type CollabConfigRowProps,
} from "@/components/session/CollabConfigRow";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "opus", effort: "high" },
  codex: { modelId: "gpt-5.4", effort: "high", codexFastMode: false },
};

function renderRow(overrides: Partial<CollabConfigRowProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <CollabConfigRow
        originatingAgent="claude"
        config={{
          agentTwo: { backend: "codex", model: "gpt-5.4", effort: "high" },
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
        }}
        backendDefaults={BACKEND_DEFAULTS}
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

  it("shows the Codex speed toggle only when Agent Two runs Codex", () => {
    const { unmount } = renderRow();
    expect(screen.getByLabelText("Codex speed")).toBeInTheDocument();
    unmount();

    renderRow({
      config: {
        agentTwo: { backend: "claude", model: "opus", effort: "high" },
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
      },
    });
    expect(screen.queryByLabelText("Codex speed")).toBeNull();
  });

  it("mirrors Agent One's composer selection as a read-only summary", () => {
    renderRow({
      agentOne: {
        backend: "claude",
        model: "fable",
        effort: "max",
      },
    });
    const summary = screen.getByTitle("Uses this conversation's settings");
    expect(summary.textContent).toContain("fable");
    expect(summary.textContent).toContain("max");
  });

  it("reseeds Agent Two's runtime from the new backend's defaults on backend switch", () => {
    const onChange = vi.fn();
    renderRow({
      onChange,
      config: {
        agentTwo: {
          backend: "codex",
          model: "gpt-5.6-sol",
          effort: "xhigh",
          fastMode: true,
          profile: "global:reviewer",
        },
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
      },
    });

    screen.getByRole("button", { name: /claude/i }).click();

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        agentTwo: {
          backend: "claude",
          model: "opus",
          effort: "high",
          // The profile is prompt identity, not runtime — it survives.
          profile: "global:reviewer",
        },
      }),
    );
  });
});
