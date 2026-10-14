import { describe, expect, it } from "vitest";
import { buildTicketRefXml } from "@/lib/tickets/references";
import { collectLiveReferenceTargets } from "./targets";

describe("live reference discovery", () => {
  it("collects direct and injected references once per identity without expanding nested notepads", () => {
    const ticket = buildTicketRefXml({
      projectName: "cc",
      ticketNumber: 90,
      title: "Capture",
    });
    expect(
      collectLiveReferenceTargets(
        `${ticket}\n<notepad-content>\n${ticket}\n<notepad-ref notepad-id="nested" name="Nested" />\n</notepad-content>`,
      ),
    ).toEqual([{ kind: "ticket", projectName: "cc", id: "90" }]);
  });

  it("ignores malformed references and literal code examples", () => {
    const ticket = buildTicketRefXml({
      projectName: "cc",
      ticketNumber: 90,
      title: "Capture",
    });
    expect(
      collectLiveReferenceTargets(
        `\`${ticket}\`\n\`\`\`xml\n${ticket}\n\`\`\`\n<execution-ref title="missing identity" />`,
      ),
    ).toEqual([]);
  });
  it("deduplicates ticket numbers with leading zeros by numeric identity", () => {
    const ticket = buildTicketRefXml({
      projectName: "cc",
      ticketNumber: 90,
      title: "Capture",
    });
    expect(
      collectLiveReferenceTargets(
        ticket +
          "\n" +
          ticket.replace('ticket-number="90"', 'ticket-number="090"'),
      ),
    ).toEqual([{ kind: "ticket", projectName: "cc", id: "90" }]);
  });
});
