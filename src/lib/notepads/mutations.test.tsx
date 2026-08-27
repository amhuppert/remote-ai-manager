// @vitest-environment jsdom
import React from "react";
import { renderHook } from "@testing-library/react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import { createTestQueryClient } from "@/test/component-mocks";
import type { NotepadSummaryResolution } from "./queries";
import { notepadKeys } from "./query-keys";
import { useWriteNotepadContentMutation } from "./mutations";
import type { Notepad } from "./schemas";

let api: FetchFixture;
let queryClient: QueryClient;

beforeEach(() => {
  api = installFetchFixture();
  queryClient = createTestQueryClient();
});
afterEach(() => {
  api.restore();
});

function notepad(revision: number): Notepad {
  return {
    id: "np-a",
    scope: "project",
    projectPath: "/repos/p1",
    name: "release 0.4 checklist",
    content: `content r${revision}`,
    revision,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function summaryOf(source: Notepad): NotepadSummaryResolution {
  return {
    state: "found",
    summary: {
      id: source.id,
      name: source.name,
      scope: source.scope,
      revision: source.revision,
      writeMode: source.writeMode,
      archived: source.archived,
    },
  };
}

function renderWriteMutation() {
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return renderHook(() => useWriteNotepadContentMutation(), { wrapper });
}

describe("useWriteNotepadContentMutation cache adoption", () => {
  it("does not let a stale response overwrite a newer cached head", async () => {
    // The race: the user's write commits as r4, an external write lands as r5
    // and the SSE refetch has already put r5 in the cache — then the slow r4
    // HTTP response arrives. Adopting it would hide the newer external head.
    queryClient.setQueryData<Notepad>(notepadKeys.detail("np-a"), notepad(5));
    queryClient.setQueryData<NotepadSummaryResolution>(
      notepadKeys.summary("np-a"),
      summaryOf(notepad(5)),
    );
    api.json("POST", "/api/notepads/np-a/content", { notepad: notepad(4) });
    const { result } = renderWriteMutation();

    await result.current.mutateAsync({
      notepadId: "np-a",
      content: "content r4",
      baseRevision: 3,
    });

    expect(
      queryClient.getQueryData<Notepad>(notepadKeys.detail("np-a"))?.revision,
    ).toBe(5);
    const summary = queryClient.getQueryData<NotepadSummaryResolution>(
      notepadKeys.summary("np-a"),
    );
    expect(summary?.state === "found" && summary.summary.revision).toBe(5);
  });

  it("adopts a response that advances the cached head", async () => {
    queryClient.setQueryData<Notepad>(notepadKeys.detail("np-a"), notepad(4));
    api.json("POST", "/api/notepads/np-a/content", { notepad: notepad(6) });
    const { result } = renderWriteMutation();

    await result.current.mutateAsync({
      notepadId: "np-a",
      content: "content r6",
      baseRevision: 4,
    });

    const cached = queryClient.getQueryData<Notepad>(
      notepadKeys.detail("np-a"),
    );
    expect(cached?.revision).toBe(6);
    expect(cached?.content).toBe("content r6");
  });
});
