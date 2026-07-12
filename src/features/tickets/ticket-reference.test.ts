import { describe, expect, it } from "vitest";

import { ticketIdentifier, ticketReferenceXml } from "./ticket-reference";

describe("ticketIdentifier", () => {
  it("joins project name and number with a hash", () => {
    expect(
      ticketIdentifier({ projectName: "command-center", number: 12 }),
    ).toBe("command-center#12");
  });
});

describe("ticketReferenceXml", () => {
  it("builds the canonical ticket-ref tag in attribute order", () => {
    expect(
      ticketReferenceXml({
        projectName: "command-center",
        number: 12,
        title: "Add durable ticket context",
      }),
    ).toBe(
      '<ticket-ref project-name="command-center" ticket-number="12" identifier="command-center#12" title="Add durable ticket context" read-command="cctl ticket get &apos;command-center#12&apos;" />',
    );
  });

  it("escapes XML-sensitive characters in the title", () => {
    const xml = ticketReferenceXml({
      projectName: "cc",
      number: 3,
      title: 'Fix <select> & "quoted" labels',
    });
    expect(xml).toContain(
      'title="Fix &lt;select&gt; &amp; &quot;quoted&quot; labels"',
    );
    expect(xml).not.toContain("<select>");
  });
});
