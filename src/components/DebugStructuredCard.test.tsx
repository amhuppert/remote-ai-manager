// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DebugStructuredCard from "./DebugStructuredCard";

describe("DebugStructuredCard — hypothesizing", () => {
  it("renders hypothesis ids, descriptions, instrumentation plans, and steps", () => {
    const payload = {
      hypotheses: [
        {
          id: "H1",
          description: "Race condition in cache invalidation",
          instrumentationPlan: "Log cache key writes with timestamps",
        },
        {
          id: "H2",
          description: "Stale closure in event handler",
          instrumentationPlan: "Print closure-captured values on each call",
        },
      ],
      reproductionSteps: ["Open the dashboard", "Click refresh twice quickly"],
    };

    render(<DebugStructuredCard phase="hypothesizing" payload={payload} />);

    expect(screen.getByText("H1")).toBeInTheDocument();
    expect(
      screen.getByText("Race condition in cache invalidation"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Log cache key writes with timestamps"),
    ).toBeInTheDocument();
    expect(screen.getByText("H2")).toBeInTheDocument();
    expect(screen.getByText("Open the dashboard")).toBeInTheDocument();
    expect(screen.getByText("Click refresh twice quickly")).toBeInTheDocument();
  });
});

describe("DebugStructuredCard — hypothesizing with optional fields", () => {
  it("renders hypotheses without instrumentationPlan (schema marks it optional)", () => {
    const payload = {
      hypotheses: [
        { id: "H1", description: "Race in cache invalidation" },
        { id: "H2", description: "Stale closure" },
      ],
      reproductionSteps: ["Step one"],
    };

    const { container } = render(
      <DebugStructuredCard phase="hypothesizing" payload={payload} />,
    );

    expect(screen.getByText("H1")).toBeInTheDocument();
    expect(screen.getByText("Race in cache invalidation")).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });
});

describe("DebugStructuredCard — analyzing_evidence", () => {
  it("renders verdict groups, outcome, and summary", () => {
    const payload = {
      outcome: "fix_applied" as const,
      supportedHypotheses: ["H1"],
      refutedHypotheses: ["H2", "H3"],
      inconclusiveHypotheses: [],
      evidenceSummary: "H1 confirmed by log timing data.",
      fixSummary: "Reordered cache writes to commit before signaling.",
      verificationSteps: ["Re-run failing test"],
    };

    render(
      <DebugStructuredCard phase="analyzing_evidence" payload={payload} />,
    );

    expect(screen.getByText("Supported")).toBeInTheDocument();
    expect(screen.getByText("Refuted")).toBeInTheDocument();
    expect(screen.getByText("Inconclusive")).toBeInTheDocument();
    expect(screen.getByText("H1")).toBeInTheDocument();
    expect(screen.getByText("H2, H3")).toBeInTheDocument();
    expect(screen.getByText("fix_applied")).toBeInTheDocument();
    expect(
      screen.getByText("H1 confirmed by log timing data."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Reordered cache writes to commit before signaling."),
    ).toBeInTheDocument();
    expect(screen.getByText("Re-run failing test")).toBeInTheDocument();
  });
});

describe("DebugStructuredCard — analyzing_evidence (more_instrumentation)", () => {
  it("renders extended hypotheses with id, description, instrumentation plan, and reproduction steps", () => {
    const payload = {
      outcome: "more_instrumentation" as const,
      supportedHypotheses: [],
      refutedHypotheses: ["H1"],
      inconclusiveHypotheses: ["H2"],
      evidenceSummary: "Initial probes refuted H1 but H2 remains unclear.",
      hypotheses: [
        {
          id: "H3",
          description: "Background job retries are clobbering state",
          instrumentationPlan: "Log retry attempts with timestamps and ids",
        },
        {
          id: "H4",
          description: "WebSocket reconnect drops queued messages",
          instrumentationPlan:
            "Trace reconnect lifecycle with sequence numbers",
        },
      ],
      reproductionSteps: ["Trigger background job", "Force socket reconnect"],
    };

    const { container } = render(
      <DebugStructuredCard phase="analyzing_evidence" payload={payload} />,
    );

    expect(screen.getByText("more_instrumentation")).toBeInTheDocument();
    expect(
      screen.getByText("Initial probes refuted H1 but H2 remains unclear."),
    ).toBeInTheDocument();
    expect(screen.getByText("H3")).toBeInTheDocument();
    expect(
      screen.getByText("Background job retries are clobbering state"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Log retry attempts with timestamps and ids"),
    ).toBeInTheDocument();
    expect(screen.getByText("H4")).toBeInTheDocument();
    expect(screen.getByText("Trigger background job")).toBeInTheDocument();
    expect(screen.getByText("Force socket reconnect")).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("falls back when more_instrumentation hypothesis entries omit required fields", () => {
    const payload = {
      outcome: "more_instrumentation" as const,
      supportedHypotheses: [],
      refutedHypotheses: [],
      inconclusiveHypotheses: [],
      evidenceSummary: "summary",
      hypotheses: [{ id: "H3" }],
      reproductionSteps: ["Step 1"],
    };

    const { container } = render(
      <DebugStructuredCard phase="analyzing_evidence" payload={payload} />,
    );

    expect(container.querySelector("pre")).not.toBeNull();
  });
});

describe("DebugStructuredCard — cleanup_instrumentation", () => {
  it("renders check icons, files modified, and notes", () => {
    const payload = {
      removedInstrumentation: true,
      filesModified: ["src/cache.ts", "src/event-handler.ts"],
      grepVerificationPassed: true,
      acknowledgesManifestDeletionContract: false,
      notes: "Manifest left in place pending PR review.",
    };

    const { container } = render(
      <DebugStructuredCard phase="cleanup_instrumentation" payload={payload} />,
    );

    expect(screen.getByText("Instrumentation removed")).toBeInTheDocument();
    expect(screen.getByText("Grep verification passed")).toBeInTheDocument();
    expect(
      screen.getByText("Manifest deletion contract acknowledged"),
    ).toBeInTheDocument();
    expect(screen.getByText("src/cache.ts")).toBeInTheDocument();
    expect(screen.getByText("src/event-handler.ts")).toBeInTheDocument();
    expect(
      screen.getByText("Manifest left in place pending PR review."),
    ).toBeInTheDocument();

    const checks = container.querySelectorAll("[data-ok]");
    expect(checks.length).toBe(3);
    expect(checks[0]?.getAttribute("data-ok")).toBe("true");
    expect(checks[1]?.getAttribute("data-ok")).toBe("true");
    expect(checks[2]?.getAttribute("data-ok")).toBe("false");
  });
});

describe("DebugStructuredCard — fallback rendering", () => {
  it("renders JSON dump when payload doesn't match the phase shape", () => {
    const payload = { unexpected: "shape", count: 42 };

    const { container } = render(
      <DebugStructuredCard phase="hypothesizing" payload={payload} />,
    );

    const fallback = container.querySelector("pre");
    expect(fallback).not.toBeNull();
    expect(fallback!.textContent).toContain("unexpected");
    expect(fallback!.textContent).toContain("shape");
    expect(fallback!.textContent).toContain("42");
  });

  it("renders JSON dump for an unsupported phase", () => {
    const { container } = render(
      <DebugStructuredCard
        phase="awaiting_reproduction"
        payload={{ anything: true }}
      />,
    );

    const fallback = container.querySelector("pre");
    expect(fallback).not.toBeNull();
  });

  it("tags the rendered card with the phase via data attribute", () => {
    const { container } = render(
      <DebugStructuredCard phase="awaiting_verification" payload={null} />,
    );
    const card = container.querySelector(".debug-structured-card");
    expect(card?.getAttribute("data-phase")).toBe("awaiting_verification");
  });
});
