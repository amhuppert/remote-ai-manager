// @vitest-environment jsdom
import React from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setOpenNotepadClipTarget } from "@/components/notepad/open-editor-registry";
import { composeAppendedNotepadContent } from "@/lib/notepads/append-composition";
import { buildClipFragment } from "@/lib/notepads/capture-fragment";
import type { NotepadListItem } from "@/lib/notepads/schemas";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import { useToastStoreForTesting } from "@/stores/toast.store";
import { createTestQueryClient } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";

import { useClipLanding } from "./use-clip-landing";

const PROJECT = "p1";
const LIST_PATH = "/api/notepads";

const CLIP = {
  text: "worth keeping",
  isCode: false,
  provenance: { kind: "ref", xml: '<message-ref message-index="3" />' },
} as const;
const FRAGMENT = buildClipFragment(CLIP);

function listItem(overrides: Partial<NotepadListItem>): NotepadListItem {
  return {
    id: "np-x",
    scope: "project",
    projectPath: "/repos/p1",
    projectName: PROJECT,
    name: "unnamed",
    revision: 1,
    writeMode: "full-edit",
    pinned: false,
    archived: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides,
  };
}

const RECENT = listItem({
  id: "np-recent",
  name: "capture target",
  updatedAt: "2026-08-30T00:00:00.000Z",
});
const STALE = listItem({
  id: "np-stale",
  name: "older notes",
  updatedAt: "2026-08-10T00:00:00.000Z",
});

function notepadBody(overrides: Record<string, unknown> = {}) {
  return {
    notepad: {
      id: "np-recent",
      scope: "project",
      projectPath: "/repos/p1",
      name: "capture target",
      content: "existing",
      revision: 4,
      writeMode: "full-edit",
      pinned: false,
      archived: false,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-30T00:00:00.000Z",
      ...overrides,
    },
  };
}

let api: FetchFixture;
let queryClient: QueryClient;

beforeEach(() => {
  api = installFetchFixture();
  queryClient = createTestQueryClient();
  useSessionDetailStore.getState().resetStore();
  useToastStoreForTesting.setState({ toasts: [] });
});
afterEach(() => {
  setOpenNotepadClipTarget("np-recent", null);
  api.restore();
  cleanup();
});

function stubList(rows: NotepadListItem[]) {
  api.reply("GET", /^\/api\/notepads\?project=p1&sort=recency&archived=true$/, {
    json: { notepads: rows },
  });
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function landingHook() {
  return renderHook(() => useClipLanding(PROJECT), { wrapper }).result;
}

function toasts() {
  return useToastStoreForTesting.getState().toasts;
}

function toastAction(label: string) {
  const action = toasts()[0]?.actions?.find((entry) => entry.label === label);
  if (!action) throw new Error(`toast has no ${label} action`);
  return action;
}

describe("useClipLanding — HTTP path", () => {
  it("lands the fragment on the most recent project notepad and confirms with Open/Undo", async () => {
    stubList([STALE, RECENT]);
    api.reply("POST", "/api/notepads/np-recent/content", {
      json: notepadBody({ content: `existing\n\n${FRAGMENT}`, revision: 5 }),
    });

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));

    const appends = api.requestsTo("POST", "/api/notepads/np-recent/content");
    expect(appends).toHaveLength(1);
    expect(appends[0]?.jsonBody).toEqual({
      operation: "append",
      content: FRAGMENT,
    });
    expect(toasts()[0]?.message).toBe("Clipped to capture target");
    expect(toasts()[0]?.actions?.map((entry) => entry.label)).toEqual([
      "Open",
      "Undo",
    ]);
  });

  it("creates an Inbox when no notepad is eligible, then appends into it", async () => {
    stubList([]);
    api.reply("POST", LIST_PATH, {
      json: notepadBody({ id: "np-new", name: "Inbox", content: "" }),
    });
    api.reply("POST", "/api/notepads/np-new/content", {
      json: notepadBody({ id: "np-new", name: "Inbox", content: FRAGMENT }),
    });

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));

    expect(api.requestsTo("POST", LIST_PATH)[0]?.jsonBody).toEqual({
      scope: "project",
      project: PROJECT,
      name: "Inbox",
    });
    expect(toasts()[0]?.message).toBe("Clipped to Inbox");
  });

  it("Open routes the right pane to the landed notepad", async () => {
    stubList([RECENT]);
    api.reply("POST", "/api/notepads/np-recent/content", {
      json: notepadBody(),
    });

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));
    act(() => toastAction("Open").onClick());

    const state = useSessionDetailStore.getState();
    expect(state.openNotepadId).toBe("np-recent");
    expect(state.rightPaneTab).toBe("notepad");
    expect(state.layout).toBe("split");
  });

  it("Undo trims the fragment and its separator when still the tail", async () => {
    stubList([RECENT]);
    // One responder for both content writes: the landing append and the undo
    // update each get a plausible head back; assertions read the wire.
    api.reply("POST", "/api/notepads/np-recent/content", (req) => {
      const operation = (req.jsonBody as { operation: string }).operation;
      return operation === "append"
        ? {
            json: notepadBody({
              content: composeAppendedNotepadContent("existing", FRAGMENT),
              revision: 5,
            }),
          }
        : { json: notepadBody({ content: "existing", revision: 6 }) };
    });
    api.json(
      "GET",
      "/api/notepads/np-recent",
      notepadBody({
        content: composeAppendedNotepadContent("existing", FRAGMENT),
        revision: 5,
      }),
    );

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));
    await act(async () => {
      toastAction("Undo").onClick();
      await waitFor(() =>
        expect(
          api
            .requestsTo("POST", "/api/notepads/np-recent/content")
            .some(
              (req) =>
                (req.jsonBody as { operation?: string }).operation === "update",
            ),
        ).toBe(true),
      );
    });

    const update = api
      .requestsTo("POST", "/api/notepads/np-recent/content")
      .find(
        (req) =>
          (req.jsonBody as { operation?: string }).operation === "update",
      );
    // The guarded write: enforceBaseRevision makes the tail check atomic —
    // a write landing after the head read refuses instead of being clobbered.
    expect(update?.jsonBody).toEqual({
      operation: "update",
      content: "existing",
      baseRevision: 5,
      enforceBaseRevision: true,
    });
  });

  it("appends and undoes a multi-message clip as one unit", async () => {
    stubList([RECENT]);
    const clips = [
      CLIP,
      {
        ...CLIP,
        text: "second message",
        provenance: {
          kind: "ref" as const,
          xml: '<message-ref message-index="4" />',
        },
      },
    ];
    const fragment = clips.map(buildClipFragment).join("\n\n");
    api.reply("POST", "/api/notepads/np-recent/content", (req) => ({
      json: notepadBody({
        content:
          (req.jsonBody as { operation: string }).operation === "append"
            ? composeAppendedNotepadContent("existing", fragment)
            : "existing",
        revision: 5,
      }),
    }));
    api.json(
      "GET",
      "/api/notepads/np-recent",
      notepadBody({
        content: composeAppendedNotepadContent("existing", fragment),
        revision: 5,
      }),
    );
    const hook = landingHook();
    await act(() => hook.current.land(clips));
    expect(toasts()).toHaveLength(1);
    expect(
      api
        .requestsTo("POST", "/api/notepads/np-recent/content")
        .map((req) => req.jsonBody),
    ).toEqual([{ operation: "append", content: fragment }]);
    await act(async () => {
      toastAction("Undo").onClick();
      await waitFor(() =>
        expect(
          api.requestsTo("POST", "/api/notepads/np-recent/content"),
        ).toHaveLength(2),
      );
    });
    expect(
      api.requestsTo("POST", "/api/notepads/np-recent/content")[1]?.jsonBody,
    ).toEqual({
      operation: "update",
      content: "existing",
      baseRevision: 5,
      enforceBaseRevision: true,
    });
  });

  it("Undo refuses when a racing write lands between the head read and the guarded update", async () => {
    stubList([RECENT]);
    const tailIntact = composeAppendedNotepadContent("existing", FRAGMENT);
    api.reply("POST", "/api/notepads/np-recent/content", (req) => {
      const operation = (req.jsonBody as { operation: string }).operation;
      if (operation === "append") {
        return { json: notepadBody({ content: tailIntact, revision: 5 }) };
      }
      // The race: another write advanced the head after the undo's read, so
      // the guarded update comes back stale instead of overwriting it.
      return {
        status: 409,
        json: {
          error:
            "This write states revision 5, but the notepad is now at revision 6.",
          code: "stale_revision",
        },
      };
    });
    api.json(
      "GET",
      "/api/notepads/np-recent",
      notepadBody({ content: tailIntact, revision: 5 }),
    );

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));
    await act(async () => {
      toastAction("Undo").onClick();
      await waitFor(() =>
        expect(
          toasts().some((toast) => toast.message.startsWith("Can't undo")),
        ).toBe(true),
      );
    });
  });

  it("Undo refuses when the fragment is no longer the content tail", async () => {
    stubList([RECENT]);
    api.reply("POST", "/api/notepads/np-recent/content", {
      json: notepadBody(),
    });
    api.json(
      "GET",
      "/api/notepads/np-recent",
      notepadBody({
        content: `${composeAppendedNotepadContent("existing", FRAGMENT)}\n\nmore typing`,
        revision: 6,
      }),
    );

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));
    await act(async () => {
      toastAction("Undo").onClick();
      await waitFor(() =>
        expect(
          toasts().some((toast) => toast.message.startsWith("Can't undo")),
        ).toBe(true),
      );
    });

    // Refusal writes nothing: the only content POST is the original append.
    expect(
      api.requestsTo("POST", "/api/notepads/np-recent/content"),
    ).toHaveLength(1);
  });
});

describe("useClipLanding — open-target path (R22.5)", () => {
  /**
   * A recording clip target standing in for the one NotepadOpenView registers.
   * The target's real behavior — buffer/editor routing, the enforced-revision
   * undo — is integration-covered in NotepadPanel.test.tsx; these tests pin
   * the landing hook's routing and toast contract around it.
   */
  function fakeTarget(undoResult: boolean | Error = true) {
    const appended: string[] = [];
    const undone: string[] = [];
    const target = {
      appendFragment(fragment: string) {
        appended.push(fragment);
      },
      undoAppend(fragment: string) {
        undone.push(fragment);
        return undoResult instanceof Error
          ? Promise.reject(undoResult)
          : Promise.resolve(undoResult);
      },
    };
    setOpenNotepadClipTarget("np-recent", target);
    useSessionDetailStore.getState().openNotepad("np-recent");
    return { appended, undone };
  }

  it("lands through the registered clip target, not HTTP, when the destination is open", async () => {
    stubList([RECENT]);
    const { appended } = fakeTarget();

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));

    expect(appended).toEqual([FRAGMENT]);
    expect(
      api.requestsTo("POST", "/api/notepads/np-recent/content"),
    ).toHaveLength(0);
    expect(toasts()[0]?.message).toBe("Clipped to capture target");
  });

  it("sends a multi-message clip through the open editor as one append and undo", async () => {
    stubList([RECENT]);
    const { appended, undone } = fakeTarget();
    const clips = [CLIP, { ...CLIP, text: "second message" }];
    const fragment = clips.map(buildClipFragment).join("\n\n");
    const hook = landingHook();
    await act(() => hook.current.land(clips));
    expect(appended).toEqual([fragment]);
    expect(toasts()).toHaveLength(1);
    await act(async () => {
      toastAction("Undo").onClick();
    });
    expect(undone).toEqual([fragment]);
    expect(
      api.requestsTo("POST", "/api/notepads/np-recent/content"),
    ).toHaveLength(0);
  });

  it("Undo delegates to the target and stays quiet when it undoes", async () => {
    stubList([RECENT]);
    const { undone } = fakeTarget(true);

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));
    await act(async () => {
      toastAction("Undo").onClick();
      await waitFor(() => expect(undone).toEqual([FRAGMENT]));
    });

    expect(
      api.requestsTo("POST", "/api/notepads/np-recent/content"),
    ).toHaveLength(0);
    expect(
      toasts().some((toast) => toast.message.startsWith("Can't undo")),
    ).toBe(false);
  });

  it("Undo reports refusal when the target says the clip is no longer undoable", async () => {
    stubList([RECENT]);
    const { undone } = fakeTarget(false);

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));
    await act(async () => {
      toastAction("Undo").onClick();
      await waitFor(() =>
        expect(
          toasts().some((toast) => toast.message.startsWith("Can't undo")),
        ).toBe(true),
      );
    });

    expect(undone).toEqual([FRAGMENT]);
  });

  it("Undo reports failure when the target's write fails outright", async () => {
    stubList([RECENT]);
    fakeTarget(new Error("network down"));

    const hook = landingHook();
    await act(() => hook.current.land(CLIP));
    await act(async () => {
      toastAction("Undo").onClick();
      await waitFor(() =>
        expect(
          toasts().some((toast) => toast.message.startsWith("Undo failed")),
        ).toBe(true),
      );
    });
  });
});
