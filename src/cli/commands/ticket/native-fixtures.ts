export const sampleDetail = {
  id: "ticket-1",
  projectPath: "/repos/cc",
  projectName: "cc",
  number: 12,
  title: "Fix the flaky gate",
  description: "It fails on Tuesdays.",
  workType: "bug",
  status: "not_started",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  attachments: [],
  sessions: [],
  relationships: [],
  statusUpdates: { total: 0, recent: [] },
};

export const sampleListItem = {
  id: "ticket-1",
  projectPath: "/repos/cc",
  projectName: "cc",
  number: 12,
  title: "Fix the flaky gate",
  workType: "bug",
  status: "not_started",
  attachmentCount: 0,
  activeSessionName: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

export const sampleRelationship = {
  id: "rel-1",
  role: "depends_on",
  otherTicket: {
    id: "ticket-2",
    projectName: "other",
    number: 7,
    title: "Ship the prerequisite",
    status: "in_progress",
  },
  description: "API contract first",
  createdAt: "2026-01-02T00:00:00Z",
  updatedAt: "2026-01-03T00:00:00Z",
};

export const sampleStatusUpdate = {
  id: "update-1",
  ticketId: "ticket-1",
  bodyMarkdown: "Implemented the first slice.",
  author: {
    kind: "agent",
    conversationId: "conversation-1",
    conversationName: "Ticket work",
    projectName: "cc",
    scope: "session",
    sessionName: "ticket-work",
    backend: "codex",
    redactedProfileSnapshot: null,
  },
  createdAt: "2026-01-04T00:00:00Z",
};
