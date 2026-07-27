import { describe, it, expect } from "vitest";
import {
  conversationCapabilityLayers,
  conversationCapabilityScope,
} from "./conversation-capability-scope";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

describe("conversationCapabilityScope", () => {
  it("addresses a project conversation's own cascade layer", () => {
    expect(
      conversationCapabilityScope({
        scope: { scope: "project" },
        projectName: "proj",
        conversationId: "plc-1",
      }),
    ).toEqual({
      level: "conversation",
      projectName: "proj",
      conversationScope: "project",
      conversationId: "plc-1",
    });
  });

  it("addresses a session conversation by its session name", () => {
    expect(
      conversationCapabilityScope({
        scope: { scope: "session", sessionName: "sess" },
        projectName: "proj",
        conversationId: "conv-1",
      }),
    ).toEqual({
      level: "conversation",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
    });
  });

  it("falls back to the project layer before a project conversation exists", () => {
    expect(
      conversationCapabilityScope({
        scope: { scope: "project" },
        projectName: "proj",
        conversationId: undefined,
      }),
    ).toEqual({ level: "project", projectName: "proj" });
  });

  // The project composer addresses a not-yet-created conversation with "".
  it("treats an empty conversation id as no conversation", () => {
    expect(
      conversationCapabilityScope({
        scope: { scope: "project" },
        projectName: "proj",
        conversationId: "",
      }),
    ).toEqual({ level: "project", projectName: "proj" });
  });

  it("falls back to the session layer before a session conversation exists", () => {
    expect(
      conversationCapabilityScope({
        scope: { scope: "session", sessionName: "sess" },
        projectName: "proj",
        conversationId: undefined,
      }),
    ).toEqual({ level: "session", projectName: "proj", sessionName: "sess" });
  });

  // The composer is handed the session-keyed storage name; the sentinel must
  // resolve to the project cascade rather than to a session named `__project__`.
  it("resolves the project cascade from a sentinel-keyed composer", () => {
    const scope = scopeRefFromStoreSessionName(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    const resolved = conversationCapabilityScope({
      scope,
      projectName: "proj",
      conversationId: "plc-1",
    });
    expect(JSON.stringify(resolved)).not.toContain(
      PROJECT_CONVERSATION_SESSION_SENTINEL,
    );
    expect(resolved).toEqual({
      level: "conversation",
      projectName: "proj",
      conversationScope: "project",
      conversationId: "plc-1",
    });
  });
});

describe("conversationCapabilityLayers", () => {
  it("omits the session layer for a project conversation", () => {
    const layers = conversationCapabilityLayers({
      scope: { scope: "project" },
      projectName: "proj",
      conversationId: "plc-1",
    });
    expect(layers.map((layer) => layer.scope?.level)).toEqual([
      "global",
      "project",
      "conversation",
    ]);
    expect(JSON.stringify(layers)).not.toContain("sessionName");
  });

  it("withholds the conversation layer until the conversation exists", () => {
    const layers = conversationCapabilityLayers({
      scope: { scope: "project" },
      projectName: "proj",
      conversationId: "",
    });
    expect(layers.map((layer) => layer.scope?.level)).toEqual([
      "global",
      "project",
    ]);
  });

  it("offers every layer for a session conversation", () => {
    const layers = conversationCapabilityLayers({
      scope: { scope: "session", sessionName: "sess" },
      projectName: "proj",
      conversationId: "conv-1",
    });
    expect(layers.map((layer) => layer.scope?.level)).toEqual([
      "global",
      "project",
      "session",
      "conversation",
    ]);
  });
});
