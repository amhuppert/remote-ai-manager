import { describe, it, expect } from "vitest";
import {
  buildTicketReadCommand,
  buildTicketRefXml,
  formatTicketIdentifier,
  parseTicketIdentifier,
} from "./references";
import { ticketRefAttrsSchema } from "./schemas";
import { parseRefAttrs } from "@/lib/conversations/ref-parser";

describe("formatTicketIdentifier", () => {
  it("joins project name and number with a hash", () => {
    expect(formatTicketIdentifier("command-center", 12)).toBe(
      "command-center#12",
    );
  });
});

describe("buildTicketReadCommand", () => {
  it("produces the globally-valid cctl read command", () => {
    expect(buildTicketReadCommand("command-center#12")).toBe(
      "cctl ticket get 'command-center#12'",
    );
  });

  it("shell-quotes identifiers containing project-name metacharacters", () => {
    expect(buildTicketReadCommand("client work; $(unsafe)#12")).toBe(
      "cctl ticket get 'client work; $(unsafe)#12'",
    );
  });
});

describe("buildTicketRefXml", () => {
  it("renders the canonical self-closing tag in canonical attribute order", () => {
    expect(
      buildTicketRefXml({
        projectName: "command-center",
        ticketNumber: 12,
        title: "Add durable ticket context",
      }),
    ).toBe(
      '<ticket-ref project-name="command-center" ticket-number="12" ' +
        'identifier="command-center#12" title="Add durable ticket context" ' +
        'read-command="cctl ticket get &apos;command-center#12&apos;" />',
    );
  });

  it("escapes XML entities in the title", () => {
    const xml = buildTicketRefXml({
      projectName: "my-app",
      ticketNumber: 3,
      title: 'Fix <a> & "b"',
    });
    expect(xml).toContain('title="Fix &lt;a&gt; &amp; &quot;b&quot;"');
  });

  it("carries exactly the five contract attributes — never paths, snapshot keys, or content", () => {
    const attrs = parseRefAttrs(
      buildTicketRefXml({
        projectName: "my-app",
        ticketNumber: 7,
        title: "T",
      }),
    );
    expect(Object.keys(attrs).sort()).toEqual([
      "identifier",
      "project-name",
      "read-command",
      "ticket-number",
      "title",
    ]);
  });

  it("produces attributes that satisfy ticketRefAttrsSchema", () => {
    const attrs = parseRefAttrs(
      buildTicketRefXml({
        projectName: "my-app",
        ticketNumber: 42,
        title: "Round trip",
      }),
    );
    const result = ticketRefAttrsSchema.safeParse(attrs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.identifier).toBe("my-app#42");
      expect(result.data["ticket-number"]).toBe("42");
      expect(result.data["read-command"]).toBe("cctl ticket get 'my-app#42'");
    }
  });
});

describe("ticketRefAttrsSchema", () => {
  it("rejects attribute maps missing a required attribute", () => {
    for (const missing of [
      "project-name",
      "ticket-number",
      "identifier",
      "title",
      "read-command",
    ]) {
      const attrs: Record<string, string> = {
        "project-name": "my-app",
        "ticket-number": "5",
        identifier: "my-app#5",
        title: "T",
        "read-command": "cctl ticket get my-app#5",
      };
      delete attrs[missing];
      expect(ticketRefAttrsSchema.safeParse(attrs).success).toBe(false);
    }
  });

  it("rejects a non-numeric ticket-number", () => {
    expect(
      ticketRefAttrsSchema.safeParse({
        "project-name": "my-app",
        "ticket-number": "twelve",
        identifier: "my-app#twelve",
        title: "T",
        "read-command": "cctl ticket get my-app#twelve",
      }).success,
    ).toBe(false);
  });
});

describe("parseTicketIdentifier", () => {
  it("round-trips the formatter's output", () => {
    expect(
      parseTicketIdentifier(formatTicketIdentifier("command-center", 12)),
    ).toEqual({
      projectName: "command-center",
      ticketNumber: 12,
    });
  });

  it("splits on the last hash so project names containing '#' survive", () => {
    expect(parseTicketIdentifier("my#app#5")).toEqual({
      projectName: "my#app",
      ticketNumber: 5,
    });
  });

  it("rejects identifiers without a positive integer number", () => {
    for (const bad of [
      "command-center",
      "command-center#",
      "#12",
      "app#twelve",
      "app#0",
      "app#-3",
      "app#1.5",
    ]) {
      expect(parseTicketIdentifier(bad)).toBeNull();
    }
  });
});
