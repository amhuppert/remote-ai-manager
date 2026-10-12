import { describe, expect, it } from "vitest";
import type { SSEEvent } from "@/lib/api/sse-events";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";
import { publishConversationCustody } from "./background-custody";
import { conversationCustodyEventSchema } from "./schemas";

describe("publishing custody of a conversation's runtime (design C5b §5)", () => {
  function recorder() {
    const published: SSEEvent[] = [];
    return {
      published,
      publish(event: SSEEvent) {
        published.push(event);
        return { delivered: true } as const;
      },
    };
  }

  it("publishes custody as it begins and as it ends, for a session conversation", () => {
    const { published, publish } = recorder();
    const identity = {
      projectName: "demo",
      sessionName: "feature-x",
      conversationId: "conv-1",
    };

    publishConversationCustody({ ...identity, custody: true }, publish);
    publishConversationCustody({ ...identity, custody: false }, publish);

    expect(
      published.map((event) => conversationCustodyEventSchema.parse(event)),
    ).toEqual([
      {
        type: "conversation-custody",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        custody: true,
      },
      {
        type: "conversation-custody",
        scope: "session",
        projectName: "demo",
        sessionName: "feature-x",
        conversationId: "conv-1",
        custody: false,
      },
    ]);
  });

  it("publishes a project conversation's custody in the project scope", () => {
    const { published, publish } = recorder();

    publishConversationCustody(
      {
        projectName: "demo",
        sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
        conversationId: "proj-1",
        custody: true,
      },
      publish,
    );

    expect(published).toEqual([
      {
        type: "conversation-custody",
        scope: "project",
        projectName: "demo",
        conversationId: "proj-1",
        custody: true,
      },
    ]);
  });

  it("never throws when the publish fails", () => {
    expect(() =>
      publishConversationCustody(
        {
          projectName: "demo",
          sessionName: "feature-x",
          conversationId: "conv-1",
          custody: true,
        },
        () => {
          throw new Error("the bus is down");
        },
      ),
    ).not.toThrow();
  });
});
