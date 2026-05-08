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
    expect(
      container.querySelector(".debug-structured-card__fallback"),
    ).toBeNull();
  });
});

describe("DebugStructuredCard — analyzing_evidence", () => {
  it("renders verdict groups, recommended next step, and summary", () => {
    const payload = {
      supportedHypotheses: ["H1"],
      refutedHypotheses: ["H2", "H3"],
      inconclusiveHypotheses: [],
      recommendedNextStep: "fix" as const,
      evidenceSummary: "H1 confirmed by log timing data.",
    };

    render(
      <DebugStructuredCard phase="analyzing_evidence" payload={payload} />,
    );

    expect(screen.getByText("Supported")).toBeInTheDocument();
    expect(screen.getByText("Refuted")).toBeInTheDocument();
    expect(screen.getByText("Inconclusive")).toBeInTheDocument();
    expect(screen.getByText("H1")).toBeInTheDocument();
    expect(screen.getByText("H2, H3")).toBeInTheDocument();
    expect(screen.getByText("fix")).toBeInTheDocument();
    expect(
      screen.getByText("H1 confirmed by log timing data."),
    ).toBeInTheDocument();
  });
});

describe("DebugStructuredCard — fixing", () => {
  it("renders fix summary and verification steps", () => {
    const payload = {
      fixSummary: "Added debounce to cache write.",
      verificationSteps: [
        "Run the app and click refresh twice",
        "Confirm no duplicate cache entries",
      ],
    };

    render(<DebugStructuredCard phase="fixing" payload={payload} />);

    expect(
      screen.getByText("Added debounce to cache write."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Run the app and click refresh twice"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Confirm no duplicate cache entries"),
    ).toBeInTheDocument();
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

    const checks = container.querySelectorAll(".debug-structured-card__check");
    expect(checks.length).toBe(3);
    expect(checks[0]?.className).toContain("debug-structured-card__check--ok");
    expect(checks[1]?.className).toContain("debug-structured-card__check--ok");
    expect(checks[2]?.className).toContain(
      "debug-structured-card__check--fail",
    );
  });
});

describe("DebugStructuredCard — fallback rendering", () => {
  it("renders JSON dump when payload doesn't match the phase shape", () => {
    const payload = { unexpected: "shape", count: 42 };

    const { container } = render(
      <DebugStructuredCard phase="hypothesizing" payload={payload} />,
    );

    const fallback = container.querySelector(
      ".debug-structured-card__fallback",
    );
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

    const fallback = container.querySelector(
      ".debug-structured-card__fallback",
    );
    expect(fallback).not.toBeNull();
  });

  it("tags the rendered card with the phase via data attribute", () => {
    const { container } = render(
      <DebugStructuredCard phase="fixing" payload={null} />,
    );
    const card = container.querySelector(".debug-structured-card");
    expect(card?.getAttribute("data-phase")).toBe("fixing");
  });
});
