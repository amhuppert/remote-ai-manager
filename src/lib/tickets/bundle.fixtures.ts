import type { TicketBundle } from "./bundle";
export function bundleFixture(): TicketBundle {
  return {
    format: "cc-ticket-bundle",
    version: 1,
    capturedAt: "2026-09-04T12:00:00.000Z",
    ticket: {
      id: "source-ticket",
      projectPath: "/old/repo",
      number: 7,
      title: "Portable context",
      description: "Keep /old/repo/design.md intact",
      workType: "feature",
      status: "in_progress",
      createdAt: "2026-09-01",
      updatedAt: "2026-09-04",
    },
    attachments: [],
    relationships: [],
    sessions: [],
    statusUpdates: [],
    roots: ["/old/repo"],
    omissions: [],
    documents: [
      {
        source: "/old/repo/design.md",
        description: "Design",
        fileName: "design.md",
        mediaType: "text/markdown",
        content: Buffer.from("Decision\n").toString("base64"),
        sha256: "",
      },
    ],
  };
}
