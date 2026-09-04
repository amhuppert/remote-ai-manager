import { describe, expect, it } from "vitest";

import { runWithTrace } from "@/lib/logging";

import {
  CALLER_CONVERSATION_HEADER,
  WORKFLOW_REPLACE_SERVER_FIELDS_MERGED_EVENT,
  WORKFLOW_VALIDATE_REFUSED_EVENT,
  callerConversationId,
  workflowReplaceServerFieldsMergedEvent,
  workflowValidateRefusedEvents,
} from "./planning-telemetry";

describe("workflowValidateRefusedEvents", () => {
  it("emits one event per issue code, carrying the record the issue named", () => {
    const events = workflowValidateRefusedEvents({
      issues: [
        { code: "invalid_plan", recordId: "wire-routes" },
        { code: "assignment_reference_invalid", recordId: "memory-cli" },
      ],
      definitionId: "def-1",
      conversationId: "conv-1",
    });

    expect(events).toEqual([
      {
        event: WORKFLOW_VALIDATE_REFUSED_EVENT,
        fields: {
          code: "invalid_plan",
          recordId: "wire-routes",
          definitionId: "def-1",
          conversationId: "conv-1",
        },
      },
      {
        event: WORKFLOW_VALIDATE_REFUSED_EVENT,
        fields: {
          code: "assignment_reference_invalid",
          recordId: "memory-cli",
          definitionId: "def-1",
          conversationId: "conv-1",
        },
      },
    ]);
  });

  it("counts a code once however many issues repeat it, keeping the first named record", () => {
    const events = workflowValidateRefusedEvents({
      issues: [
        { code: "invalid_plan" },
        { code: "invalid_plan", recordId: "memory-cli" },
        { code: "invalid_plan", recordId: "wire-routes" },
      ],
      conversationId: "conv-1",
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.fields).toEqual({
      code: "invalid_plan",
      recordId: "memory-cli",
      conversationId: "conv-1",
    });
  });

  it("carries conversationId on every event, null for a caller outside a conversation", () => {
    // The event exists so a retrospective can group planning friction by the
    // conversation that met it. A shape that could omit the key would drop
    // exactly the callers being counted, so the field is never conditional.
    const events = workflowValidateRefusedEvents({
      issues: [{ code: "region_locked" }, { code: "invalid_plan" }],
      definitionId: null,
      conversationId: null,
    });

    expect(events.map((event) => event.fields)).toEqual([
      { code: "region_locked", conversationId: null },
      { code: "invalid_plan", conversationId: null },
    ]);
    for (const event of events) {
      expect(Object.hasOwn(event.fields, "conversationId")).toBe(true);
    }
  });

  it("omits recordId and definitionId when the refusal names neither", () => {
    const events = workflowValidateRefusedEvents({
      issues: [{ code: "region_locked" }],
      definitionId: null,
      conversationId: "conv-1",
    });

    expect(events).toEqual([
      {
        event: WORKFLOW_VALIDATE_REFUSED_EVENT,
        fields: { code: "region_locked", conversationId: "conv-1" },
      },
    ]);
  });

  it("emits nothing for a refusal with no issue codes", () => {
    expect(
      workflowValidateRefusedEvents({ issues: [], conversationId: "conv-1" }),
    ).toEqual([]);
  });

  it("carries ids and codes only — never a message, path or plan prose", () => {
    const events = workflowValidateRefusedEvents({
      issues: [{ code: "invalid_plan", recordId: "wire-routes" }],
      definitionId: "def-1",
      conversationId: "conv-1",
    });

    const values = JSON.stringify(events[0]?.fields);
    expect(Object.keys(events[0]?.fields ?? {}).sort()).toEqual([
      "code",
      "conversationId",
      "definitionId",
      "recordId",
    ]);
    expect(values).not.toContain("must be");
    expect(values).not.toContain("definition.tasks");
  });
});

describe("workflowReplaceServerFieldsMergedEvent", () => {
  it("names the server-owned paths the merge filled", () => {
    expect(
      workflowReplaceServerFieldsMergedEvent({
        definitionId: "def-1",
        fields: ["/origin", "/approvalRequired"],
        conversationId: "conv-1",
      }),
    ).toEqual({
      event: WORKFLOW_REPLACE_SERVER_FIELDS_MERGED_EVENT,
      fields: {
        definitionId: "def-1",
        fields: ["/origin", "/approvalRequired"],
        conversationId: "conv-1",
      },
    });
  });

  it("is absent when the merge filled nothing", () => {
    expect(
      workflowReplaceServerFieldsMergedEvent({
        definitionId: "def-1",
        fields: [],
        conversationId: "conv-1",
      }),
    ).toBeNull();
  });

  it("carries a null conversationId outside a conversation rather than dropping the key", () => {
    expect(
      workflowReplaceServerFieldsMergedEvent({
        definitionId: "def-1",
        fields: ["/lockedRegions"],
        conversationId: null,
      })?.fields,
    ).toEqual({
      definitionId: "def-1",
      fields: ["/lockedRegions"],
      conversationId: null,
    });
  });
});

describe("callerConversationId", () => {
  function requestWith(headers: Record<string, string>): Request {
    return new Request("https://cc.test/api/workflows", { headers });
  }

  it("reads the conversation the calling agent named on the header", () => {
    // The graph-workflow write routes carry no conversationId route parameter,
    // so the ambient trace has none to offer: the header is the only place an
    // agent's identity can arrive from.
    expect(
      callerConversationId(
        requestWith({ [CALLER_CONVERSATION_HEADER]: "conv-1" }),
      ),
    ).toBe("conv-1");
  });

  it("trims a padded header value", () => {
    expect(
      callerConversationId(
        requestWith({ [CALLER_CONVERSATION_HEADER]: "  conv-1  " }),
      ),
    ).toBe("conv-1");
  });

  it("falls back to the ambient trace when the route is conversation-scoped", () => {
    expect(
      runWithTrace({ traceId: "t-1", conversationId: "conv-trace" }, () =>
        callerConversationId(requestWith({})),
      ),
    ).toBe("conv-trace");
  });

  it("is null for a caller with no conversation at all", () => {
    expect(callerConversationId(requestWith({}))).toBeNull();
    expect(
      callerConversationId(requestWith({ [CALLER_CONVERSATION_HEADER]: "  " })),
    ).toBeNull();
  });
});
