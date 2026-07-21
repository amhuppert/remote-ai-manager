// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  DecisionMentionNode,
  RefPasteHandler,
  RequirementMentionNode,
  SpecMentionNode,
  TaskMentionNode,
  serializePromptDoc,
  type SpecElementMentionAttrs,
  type SpecMentionAttrs,
} from "@/lib/prompt-editor";
import type { SpecElementView, SpecSummaryView } from "@/lib/specs/queries";
import { specKeys } from "@/lib/specs/query-keys";
import { registerSpecSseReactions } from "@/lib/specs/sse-reactions";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import {
  createCopyReferenceControl,
  createSpecRefChips,
  type CopyReferenceControlProps,
} from "./SpecRefChips";

function summary(phase: SpecSummaryView["phase"]["primary"]): SpecSummaryView {
  return {
    spec: {
      id: "spec-1",
      projectPath: "/repos/demo",
      slug: "native-sdd",
      name: "Native SDD",
      gatePolicy: { preset: "contract-bearing" },
      abandonedAt: null,
      abandonedReason: null,
      createdAt: "2026-07-18T00:00:00Z",
      updatedAt: "2026-07-18T00:00:00Z",
    },
    phase: { primary: phase },
    currentRevision: {
      id: "revision-3",
      specId: "spec-1",
      number: 3,
      state: "draft",
      basedOnRevisionId: "revision-2",
      contentHash: null,
      proposedAt: null,
      approvedAt: null,
      createdAt: "2026-07-18T00:00:00Z",
    },
    counts: { requirements: 2, criteria: 5, decisions: 1, tasks: 3 },
    pendingApprovalCount: phase === "approved" ? 0 : 2,
    approvalState: phase === "approved" ? "complete" : "pending",
    delivery: { allWaived: false, provenCount: 0, totalInScope: 0 },
    linkedWork: {
      tickets: 0,
      conversations: 0,
      sessions: 0,
      workflowExecutions: 0,
      mergeJobs: 0,
    },
  };
}

function elementView(
  latestPayloadHash: string,
  latestContainingRevision: number,
): SpecElementView {
  return {
    specId: "spec-1",
    slug: "native-sdd",
    revision: {
      id: `revision-${latestContainingRevision}`,
      specId: "spec-1",
      number: latestContainingRevision,
      state: "draft",
      basedOnRevisionId: "revision-1",
      contentHash: null,
      proposedAt: null,
      approvedAt: null,
      createdAt: "2026-07-18T00:00:00Z",
    },
    handle: "R5",
    element: {
      element: {
        id: "requirement-5",
        specId: "spec-1",
        kind: "requirement",
        number: 5,
        parentElementId: null,
        createdAt: "2026-07-18T00:00:00Z",
      },
      version: {
        revisionId: `revision-${latestContainingRevision}`,
        elementId: "requirement-5",
        position: 0,
        payload: {
          kind: "requirement",
          statement: "References remain addressable",
          priority: "must",
          risk: "medium",
        },
        payloadHash: latestPayloadHash,
        elementVersion: 2,
        createdAt: "2026-07-18T00:00:00Z",
        updatedAt: "2026-07-18T00:00:00Z",
      },
    },
    approvals: [],
    evidenceState: [],
    referenceState: {
      observedRevision: 1,
      observedPayloadHash: "observed-hash",
      latestContainingRevision,
      latestPayloadHash,
    },
  };
}

const specAttrs = {
  "project-name": "demo",
  slug: "native-sdd",
  name: "Name observed at insert",
  revision: "1",
  "read-command": "cctl spec show 'native-sdd' --project 'demo'",
} as const;

const requirementAttrs = {
  "project-name": "demo",
  slug: "native-sdd",
  handle: "R5",
  name: "Statement observed at insert",
  revision: "1",
  "read-command": "cctl spec get 'native-sdd/R5' --project 'demo'",
} as const;

describe("spec reference chips", () => {
  it("updates the rendered phase after a published spec event refetches live state", async () => {
    let serverSummary = summary("draft");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const fake = new FakeEventSource("/api/events");
    registerSpecSseReactions(fake as unknown as EventSource, { queryClient });
    const { SpecRefTranscriptChip } = createSpecRefChips({
      useSpecSummary(projectName, slug) {
        return useQuery({
          queryKey: specKeys.summary(projectName, slug),
          queryFn: async () => serverSummary,
        });
      },
      useSpecElement() {
        return { data: undefined, isLoading: false, isError: false };
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <SpecRefTranscriptChip attrs={specAttrs} />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("link", { name: /Native SDD.*Draft/ }),
    ).toBeVisible();

    serverSummary = summary("approved");
    act(() => {
      fake.emit("spec-revision-changed", {
        type: "spec-revision-changed",
        projectPath: "/repos/demo",
        specId: "spec-1",
        specSlug: "native-sdd",
        occurredAt: "2026-07-18T00:00:00Z",
        kind: "revision-approved",
        revisionId: "revision-2",
      });
    });

    await waitFor(() => {
      expect(
        screen.getByRole("link", { name: /Native SDD.*Approved/ }),
      ).toBeVisible();
    });
  });

  it("renders live name and phase, then reflects a live phase update", async () => {
    let currentSummary = summary("draft");
    const { SpecRefTranscriptChip } = createSpecRefChips({
      useSpecSummary() {
        return { data: currentSummary, isLoading: false, isError: false };
      },
      useSpecElement() {
        return { data: undefined, isLoading: false, isError: false };
      },
    });
    const { rerender } = render(<SpecRefTranscriptChip attrs={specAttrs} />);

    expect(
      screen.getByRole("link", { name: /Native SDD.*Draft/ }),
    ).toHaveAttribute("href", "/specs/demo/native-sdd");

    currentSummary = summary("approved");
    rerender(<SpecRefTranscriptChip attrs={specAttrs} />);

    expect(
      screen.getByRole("link", { name: /Native SDD.*Approved/ }),
    ).toBeVisible();
  });

  it("shows phase, requirement counts, and approval state in the hover peek", async () => {
    const user = userEvent.setup();
    const { SpecRefTranscriptChip } = createSpecRefChips({
      useSpecSummary() {
        return { data: summary("approved"), isLoading: false, isError: false };
      },
      useSpecElement() {
        return { data: undefined, isLoading: false, isError: false };
      },
    });
    render(<SpecRefTranscriptChip attrs={specAttrs} />);

    await user.hover(screen.getByRole("link", { name: /Native SDD/ }));

    expect(await screen.findByText("2 requirements")).toBeVisible();
    expect(screen.getByText("5 acceptance criteria")).toBeVisible();
    expect(screen.getByText("Approval complete")).toBeVisible();
  });

  it("renders the prototype live revision, preset, counts, and approval progress", async () => {
    const user = userEvent.setup();
    const liveSummary = summary("in_review");
    liveSummary.currentRevision = {
      ...liveSummary.currentRevision!,
      number: 4,
      state: "proposed",
    };
    liveSummary.counts = {
      requirements: 11,
      criteria: 16,
      decisions: 4,
      tasks: 13,
    };
    liveSummary.pendingApprovalCount = 6;
    const { SpecRefTranscriptChip } = createSpecRefChips({
      useSpecSummary() {
        return { data: liveSummary, isLoading: false, isError: false };
      },
      useSpecElement() {
        return { data: undefined, isLoading: false, isError: false };
      },
    });
    render(<SpecRefTranscriptChip attrs={specAttrs} />);

    const chip = screen.getByRole("link", { name: /Native SDD.*In review/ });
    expect(within(chip).getByText("native-sdd")).toBeVisible();
    await user.hover(chip);

    const peek = await screen.findByLabelText("Spec summary");
    expect(
      within(peek).getByText("native-sdd · rev 4 proposed · Contract-bearing"),
    ).toBeVisible();
    expect(within(peek).getByLabelText("11 req")).toBeVisible();
    expect(within(peek).getByLabelText("4 dec")).toBeVisible();
    expect(within(peek).getByLabelText("13 tasks")).toBeVisible();
    expect(within(peek).getByLabelText("10/16 approvals")).toBeVisible();
    expect(
      within(peek).getByRole("progressbar", {
        name: "10 of 16 approvals",
      }),
    ).toHaveAttribute("aria-valuenow", "10");
    expect(
      within(peek).getByRole("link", { name: "open in Spec Studio" }),
    ).toHaveAttribute("href", "/specs/demo/native-sdd");
  });

  it("deep-links the live element statement and clears staleness when content is restored", () => {
    let currentElement = elementView("changed-hash", 2);
    const { SpecElementRefTranscriptChip } = createSpecRefChips({
      useSpecSummary() {
        return { data: undefined, isLoading: false, isError: false };
      },
      useSpecElement() {
        return { data: currentElement, isLoading: false, isError: false };
      },
    });
    const { rerender } = render(
      <SpecElementRefTranscriptChip attrs={requirementAttrs} />,
    );

    const chip = screen.getByRole("link", {
      name: /native-sdd\/R5.*References remain addressable.*Changed/,
    });
    expect(chip).toHaveAttribute("href", "/specs/demo/native-sdd?el=R5");
    expect(chip).toHaveClass("align-middle");
    expect(chip).not.toHaveClass("align-[-3px]");

    currentElement = elementView("observed-hash", 3);
    rerender(<SpecElementRefTranscriptChip attrs={requirementAttrs} />);

    expect(screen.queryByText("Changed")).toBeNull();
    expect(
      screen.getByRole("link", {
        name: /native-sdd\/R5.*References remain addressable/,
      }),
    ).toBeVisible();
  });

  it("keeps an untouched element fresh in a newer revision", () => {
    const { SpecElementRefTranscriptChip } = createSpecRefChips({
      useSpecSummary() {
        return { data: undefined, isLoading: false, isError: false };
      },
      useSpecElement() {
        return {
          data: elementView("observed-hash", 2),
          isLoading: false,
          isError: false,
        };
      },
    });
    render(<SpecElementRefTranscriptChip attrs={requirementAttrs} />);

    expect(screen.queryByText("Changed")).toBeNull();
  });

  it("explains the observed and current revisions in a changed element peek", async () => {
    const changedElement = elementView("changed-hash", 2);
    changedElement.approvals = [
      {
        id: "approval-r5",
        spec_id: "spec-1",
        subject_kind: "requirement",
        element_id: "requirement-5",
        revision_id: "revision-1",
        approver: "alex",
        granted_at: "2026-07-18T00:00:00Z",
        validity: "stale",
      },
    ];
    const { SpecElementRefTranscriptChip } = createSpecRefChips({
      useSpecSummary() {
        return { data: undefined, isLoading: false, isError: false };
      },
      useSpecElement() {
        return {
          data: changedElement,
          isLoading: false,
          isError: false,
        };
      },
    });
    const user = userEvent.setup();
    render(<SpecElementRefTranscriptChip attrs={requirementAttrs} />);

    const chip = screen.getByRole("link", { name: /native-sdd\/R5/ });
    expect(within(chip).queryByText("Changed")).toBeNull();
    await user.hover(chip);

    expect(await screen.findByText("rev 1 observed")).toBeVisible();
    expect(
      screen.getByText("rev 2 current — changed since referenced"),
    ).toBeVisible();
    expect(screen.getByText("Approval stale")).toBeVisible();
  });
});

const COPY_FIXTURES: Array<{
  referenceType: CopyReferenceControlProps["referenceType"];
  nodeName: string;
  attrs: SpecMentionAttrs | SpecElementMentionAttrs;
}> = [
  {
    referenceType: "spec",
    nodeName: "specMention",
    attrs: {
      projectName: "demo",
      slug: "native-sdd",
      name: "Native SDD",
      revision: "3",
      readCommand: "",
    },
  },
  ...(["requirement", "decision", "task"] as const).map((referenceType) => ({
    referenceType,
    nodeName: `${referenceType}Mention`,
    attrs: {
      projectName: "demo",
      slug: "native-sdd",
      handle:
        referenceType === "requirement"
          ? "R5"
          : referenceType === "decision"
            ? "D2"
            : "T15",
      name: `${referenceType} label`,
      revision: "3",
      readCommand: "",
    },
  })),
];

describe("CopyReferenceControl", () => {
  for (const fixture of COPY_FIXTURES) {
    it(`copies a ${fixture.referenceType} tag that pastes to the identical chip`, async () => {
      let copied = "";
      const CopyReferenceControl = createCopyReferenceControl({
        async writeText(text) {
          copied = text;
        },
      });
      const user = userEvent.setup();
      render(
        <CopyReferenceControl
          referenceType={fixture.referenceType}
          attrs={fixture.attrs}
        />,
      );

      await user.click(screen.getByRole("button", { name: "Copy reference" }));

      const editor = new Editor({
        element: document.createElement("div"),
        extensions: [
          StarterKit,
          SpecMentionNode,
          RequirementMentionNode,
          DecisionMentionNode,
          TaskMentionNode,
          RefPasteHandler,
        ],
        content: "<p></p>",
      });
      editor.commands.focus("end");
      editor.view.pasteText(copied, pasteEvent(copied));

      expect(editor.state.doc.firstChild?.firstChild?.type.name).toBe(
        fixture.nodeName,
      );
      expect(
        serializePromptDoc({ doc: editor.state.doc, attachments: [] }).prompt,
      ).toBe(copied);
      editor.destroy();
    });
  }
});

function pasteEvent(text: string): ClipboardEvent {
  const event = new Event("paste", {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", {
    value: {
      getData: (type: string) => (type === "text/plain" ? text : ""),
    },
  });
  return event;
}
