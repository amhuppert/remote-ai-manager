import { describe, expect, it } from "vitest";
import { classifyWorkflowRequestPrincipal } from "@/lib/workflow-graph/request-principal";
import {
  CONVERSATION_IDENTITY_HEADER,
  encodeConversationIdentity,
  readConversationIdentity,
} from "./conversation-identity";

describe("conversation identity HTTP transport", () => {
  it.each(["skill-sync – planning", "日本語 🧪", "café"])(
    "keeps %s header-safe without changing session membership",
    async (sessionName) => {
      const scope = { sessionName, conversationId: "caller" };
      const encoded = encodeConversationIdentity(scope);
      expect(encoded).toMatch(/^[\x20-\x7e]+$/);
      const request = new Request("http://cc.test/api/workflows", {
        headers: new Headers({ [CONVERSATION_IDENTITY_HEADER]: encoded }),
      });
      expect(
        readConversationIdentity(
          request.headers.get(CONVERSATION_IDENTITY_HEADER),
        ),
      ).toEqual({ kind: "valid", scope });
      const deps = {
        async validateOptionalToken() {
          return { kind: "valid" } as const;
        },
        async readLaneIdentity() {
          return { kind: "absent" } as const;
        },
        async readConversationIdentity(request: Request) {
          return readConversationIdentity(
            request.headers.get(CONVERSATION_IDENTITY_HEADER),
          );
        },
      };
      expect(
        await classifyWorkflowRequestPrincipal(
          request,
          { sessionName, conversationIds: ["caller"] },
          deps,
        ),
      ).toEqual({
        kind: "principal",
        principal: { kind: "conversation", conversationId: "caller" },
      });
      expect(
        await classifyWorkflowRequestPrincipal(
          request,
          { sessionName: "another session", conversationIds: ["caller"] },
          deps,
        ),
      ).toEqual({ kind: "unverified", reason: "session_mismatch" });
    },
  );
});
