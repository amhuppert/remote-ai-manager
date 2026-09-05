// @vitest-environment jsdom
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { renderWithQuery } from "@/test/component-mocks";
import { memoryNoteSchema } from "@/lib/memory/schemas";
import MemoryEntryLink from "./MemoryEntryLink";

let api: FetchFixture;
beforeEach(() => {
  api = installFetchFixture();
});
afterEach(() => {
  cleanup();
  api.restore();
});
const note = memoryNoteSchema.parse({
  id: "m1",
  slug: "global-lesson",
  scope: "global",
  projectPath: null,
  sessionName: null,
  sessionCreatedAt: null,
  kind: "lesson",
  hook: "use a scoped fixture server",
  body: "",
  statusNote: null,
  aliases: [],
  indexMode: "auto",
  lifecycle: "proposed",
  reviewAfter: null,
  expiresAt: null,
  supersedesId: null,
  supersededById: null,
  createdBy: "agent",
  authorConversationId: null,
  revision: 1,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
});
it("counts global proposals in the topbar while retaining the project destination", async () => {
  api.reply("GET", /^\/api\/memory\/notes\?lifecycle=proposed$/, {
    json: { notes: [note] },
  });
  renderWithQuery(<MemoryEntryLink projectName="cc" placement="topbar" />);
  const link = await screen.findByRole("link", {
    name: "Memory · 1 global proposal awaiting approval",
  });
  expect(link.getAttribute("href")).toBe("/memory?project=cc&queue=proposed");
});
it("deduplicates overlapping proposal and review work in the cockpit", async () => {
  api.reply("GET", /^\/api\/memory\/notes\?project=cc\&lifecycle=proposed$/, {
    json: { notes: [note] },
  });
  api.reply("GET", /^\/api\/memory\/review\?project=cc$/, {
    json: {
      entries: [
        {
          note,
          staleness: [{ cause: "lease", target: "note" }],
          noteReviewDue: true,
          statusReviewDue: false,
          expired: false,
          promotionCandidate: false,
        },
      ],
    },
  });
  api.reply(
    "GET",
    /^\/api\/memory\/review\?project=cc\&projectCandidates=true$/,
    { json: { entries: [] } },
  );
  renderWithQuery(<MemoryEntryLink projectName="cc" placement="cockpit" />);
  const link = await screen.findByRole("link", {
    name: "Memory · 1 note needs attention",
  });
  expect(link.getAttribute("href")).toBe("/memory?project=cc&queue=attention");
});
