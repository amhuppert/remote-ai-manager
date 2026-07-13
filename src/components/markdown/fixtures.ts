export interface MarkdownFixture {
  name: string;
  content: string;
}

export const LONG_UNBROKEN_TOKEN =
  "commandcentercanonicalmarkdownrenderercontainsthisverylongunbrokentokenwithoutwideningthepage";

export const LONG_URL =
  "https://example.com/command-center/canonical-markdown/a-very-long-path-segment-that-must-wrap-without-expanding-the-page";

export const CANONICAL_MARKDOWN_FIXTURES = [
  {
    name: "headings and inline formatting",
    content: `# Canonical heading

## Semantic section

Text with **strong emphasis**, *gentle emphasis*, and ~~retired text~~.`,
  },
  {
    name: "nested and task lists",
    content: `- Parent item
  - Nested item
- [x] Completed task
- [ ] Pending task

1. First step
2. Second step`,
  },
  {
    name: "blockquote and thematic break",
    content: `> A quoted constraint.

---`,
  },
  {
    name: "safe links and autolinks",
    content: `[internal route](/tickets/2)

[external docs](https://example.com/docs)

[relative file](./docs/guide.md)

[blocked file scheme](file:///tmp/report.md)

<https://autolink.example/path>`,
  },
  {
    name: "responsive table",
    content: `| Surface | Intent |
| --- | --- |
| Ticket description | Document |
| Workflow event | Compact |`,
  },
  {
    name: "raw HTML safety",
    content:
      'Raw HTML stays inert: <button data-raw-html onclick="window.__rawMarkdownExecuted = true">Unsafe control</button> <script>window.__rawMarkdownExecuted = true</script>',
  },
  {
    name: "inline and highlighted code",
    content: [
      "Use `const inline = true` without a copy control.",
      "",
      "```typescript",
      'const canonical: string = "markdown";',
      "```",
    ].join("\n"),
  },
  {
    name: "unknown fenced code",
    content: ["```unknown-language", "plain fallback()", "```"].join("\n"),
  },
  {
    name: "Mermaid",
    content: [
      "```mermaid",
      "flowchart LR",
      "  Contract --> Renderer",
      "```",
    ].join("\n"),
  },
  {
    name: "long content and image containment",
    content: `Long token: ${LONG_UNBROKEN_TOKEN}

Long URL: <${LONG_URL}>

![Architecture diagram](https://example.com/architecture.png)`,
  },
] as const satisfies readonly MarkdownFixture[];

export const CANONICAL_MARKDOWN_SHOWCASE = CANONICAL_MARKDOWN_FIXTURES.map(
  ({ content }) => content,
).join("\n\n");
