import { describe, expect, it } from "vitest";
import type { QuickTicketDiagnostics } from "./schemas";
import { composeQuickTicketDiagnosticReport } from "./diagnostics";

function diagnostics(
  overrides: Partial<QuickTicketDiagnostics> = {},
): QuickTicketDiagnostics {
  return {
    capturedAt: "2026-07-19T12:00:00.000Z",
    route: {
      url: "/projects/source/work?c=conv-1",
      viewState: "pane=chat; tab=conversation",
    },
    identities: {
      projectName: "source",
      sessionName: "work",
      conversationId: "conv-1",
      workflowExecutionId: "workflow-1",
      deepLinks: [
        {
          label: "Conversation",
          href: "/projects/source/work?c=conv-1",
        },
      ],
    },
    clientErrors: [
      {
        ts: "2026-07-19T11:59:00.000Z",
        kind: "console",
        message: "Request failed",
        stackHead: ["at submit (QuickTicketDialog.tsx:1:1)"],
      },
    ],
    removed: [],
    ...overrides,
  };
}

const environment = {
  sha: "abc123",
  buildTime: "2026-07-19T10:00:00.000Z",
  appVersion: "0.1.0",
  platform: "darwin-arm64-node22.11.0",
};

describe("composeQuickTicketDiagnosticReport", () => {
  it("composes deterministic sections and a self-reference-free cctl crib", () => {
    const report = composeQuickTicketDiagnosticReport(
      diagnostics(),
      environment,
    );

    expect(report).toContain("## Route + view state");
    expect(report).toContain("/projects/source/work?c=conv-1");
    expect(report).toContain("## Observed identities + deep links");
    expect(report).toContain("workflow-1");
    expect(report).toContain("## Server build + environment");
    expect(report).toContain("abc123");
    expect(report).toContain("## cctl crib");
    expect(report).toContain(
      "cctl conversation read 'conv-1' --outline --project 'source' --session 'work'",
    );
    expect(report).toContain(
      "cctl conversation compaction get 'conv-1' --project 'source' --session 'work' --format markdown",
    );
    expect(report).toContain("debug-logs");
    expect(report).toContain("## Recent client errors");
    expect(report).not.toContain("cctl ticket get");
    expect(report).not.toContain("cctl ticket attachment get");
  });

  it("honors removed keys without hiding unrelated facts", () => {
    const report = composeQuickTicketDiagnosticReport(
      diagnostics({
        removed: ["route", "cctl", "clientErrors"],
      }),
      environment,
    );

    expect(report).not.toContain("## Route + view state");
    expect(report).not.toContain("## cctl crib");
    expect(report).not.toContain("## Recent client errors");
    expect(report).toContain("## Observed identities + deep links");
    expect(report).toContain("## Server build + environment");
  });

  it("omits the crib when there is no observed conversation", () => {
    const report = composeQuickTicketDiagnosticReport(
      diagnostics({
        identities: {
          projectName: "source",
          deepLinks: [],
        },
      }),
      environment,
    );

    expect(report).not.toContain("## cctl crib");
  });

  it("returns null when every note-backed bundle item is removed", () => {
    expect(
      composeQuickTicketDiagnosticReport(
        diagnostics({
          removed: ["route", "identities", "cctl", "build", "clientErrors"],
        }),
        environment,
      ),
    ).toBeNull();
  });
});
