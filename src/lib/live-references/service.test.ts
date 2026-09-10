import { describe, expect, it } from "vitest";
import { buildTicketRefXml } from "@/lib/tickets/references";
import { appendLiveReferenceSummaries, resolveLiveReferences } from "./service";
import type { LiveReferenceSummary } from "./schemas";

const summary: LiveReferenceSummary = {
  title: "Current title",
  identity: "cc#90",
  status: "Done",
  tone: "green",
  href: "/tickets/cc/90",
  readCommand: "cctl ticket get 'cc#90'",
  details: [],
  attentionCount: 0,
};

describe("live reference summaries", () => {
  it("isolates missing, failed and timed-out reads while preserving available state", async () => {
    const results = await resolveLiveReferences(
      ["90", "91", "92", "93"].map((id) => ({
        kind: "ticket",
        projectName: "cc",
        id,
      })),
      {
        async read(target) {
          if (target.id === "91") return null;
          if (target.id === "92") throw new Error("offline");
          if (target.id === "93") return new Promise(() => {});
          return summary;
        },
      },
      20,
    );
    expect(
      results.map(
        (result) => result.summary?.status ?? result.unavailableReason,
      ),
    ).toEqual(["Done", "missing", "error", "timeout"]);
    expect(
      results.every((result) => Number.isFinite(Date.parse(result.checkedAt))),
    ).toBe(true);
  });

  it("captures current state at each delivery, deduplicates references and preserves original text", async () => {
    const ref = buildTicketRefXml({
      projectName: "cc",
      ticketNumber: 90,
      title: "Captured title",
    });
    const source = `${ref}\n<notepad-content>${ref}</notepad-content>`;
    let status = "In Progress";
    const reader = {
      async read() {
        return { ...summary, status };
      },
    };
    expect(await appendLiveReferenceSummaries(source, reader)).toContain(
      'status="In Progress"',
    );
    status = "Done";
    const delivered = await appendLiveReferenceSummaries(source, reader);
    expect(delivered.startsWith(source)).toBe(true);
    expect(delivered).toContain('status="Done"');
    expect(delivered.match(/<entity-state /g)).toHaveLength(1);
    expect(delivered).toContain('checked-at="');
  });

  it("sends an explicit unavailable result and escapes entity text", async () => {
    const text = buildTicketRefXml({
      projectName: "cc",
      ticketNumber: 90,
      title: "Captured",
    });
    expect(
      await appendLiveReferenceSummaries(text, {
        async read() {
          throw new Error("private failure");
        },
      }),
    ).toContain('unavailable="error"');
    expect(
      await appendLiveReferenceSummaries(text, {
        async read() {
          return { ...summary, title: '<title>"' };
        },
      }),
    ).toContain('title="&lt;title&gt;&quot;"');
  });
});
