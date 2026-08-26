// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiCallError } from "@/lib/api/errors";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { collaborationKeys } from "@/lib/workflows/query-keys";
import { useCollaborationStore } from "@/stores/collaboration.store";
import { createPeekReplySubmitter } from "./use-peek-reply";
import { usePeekReply } from "./use-peek-reply";

const noopLogger = {
  info() {},
  error() {},
};

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

describe("createPeekReplySubmitter", () => {
  it("emits structured lifecycle logs through injected client-safe deps", async () => {
    const events: Array<{
      level: "info" | "error";
      message: string;
      fields: Record<string, unknown>;
    }> = [];
    const submitPeekReply = createPeekReplySubmitter({
      async fetcher() {
        return { ok: true };
      },
      logger: {
        info(message, fields) {
          events.push({ level: "info", message, fields });
        },
        error(message, fields) {
          events.push({ level: "error", message, fields });
        },
      },
    });

    await submitPeekReply({
      projectName: "Project One",
      sessionName: "Session One",
      conversationId: "conv-one",
      text: "Hello",
    });

    expect(events).toEqual([
      {
        level: "info",
        message: "peek_reply.submit",
        fields: {
          projectName: "Project One",
          sessionName: "Session One",
          conversationId: "conv-one",
          textLength: 5,
          collaborationRequested: false,
        },
      },
      {
        level: "info",
        message: "peek_reply.success",
        fields: {
          projectName: "Project One",
          sessionName: "Session One",
          conversationId: "conv-one",
        },
      },
    ]);
  });

  it("posts the reply to the targeted conversation prompt endpoint", async () => {
    const parsedResponse = { ok: true, conversationId: "conv/one" };
    const calls: Array<{
      url: string;
      traceLabel: string;
      options: RequestInit;
    }> = [];
    const submitPeekReply = createPeekReplySubmitter({
      async fetcher(url, traceLabel, options) {
        calls.push({ url, traceLabel, options });
        return parsedResponse;
      },
      logger: noopLogger,
    });

    await expect(
      submitPeekReply({
        projectName: "Project One",
        sessionName: "Session/One",
        conversationId: "conv/one",
        text: "  Hello from peek  ",
      }),
    ).resolves.toBe(parsedResponse);

    expect(calls).toEqual([
      {
        url: "/api/projects/Project%20One/sessions/Session%2FOne/conversations/conv%2Fone/prompt",
        traceLabel: "peek-reply",
        options: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Hello from peek" }),
        },
      },
    ]);
  });

  it("forwards ordered rich-prompt images to the targeted conversation", async () => {
    const calls: RequestInit[] = [];
    const submitPeekReply = createPeekReplySubmitter({
      async fetcher(_url, _traceLabel, options) {
        calls.push(options);
        return { ok: true };
      },
      logger: noopLogger,
    });

    await submitPeekReply({
      projectName: "Project One",
      sessionName: "Session One",
      conversationId: "conv-one",
      text: "Compare these",
      images: [
        {
          attachmentId: "first",
          mediaType: "image/png",
          base64Data: "first-data",
        },
        {
          attachmentId: "second",
          mediaType: "image/jpeg",
          base64Data: "second-data",
        },
      ],
    });

    expect(calls[0]?.body).toBe(
      JSON.stringify({
        prompt: "Compare these",
        images: [
          {
            attachmentId: "first",
            mediaType: "image/png",
            base64Data: "first-data",
          },
          {
            attachmentId: "second",
            mediaType: "image/jpeg",
            base64Data: "second-data",
          },
        ],
      }),
    );
  });

  it("forwards the selected collaboration configuration", async () => {
    const calls: RequestInit[] = [];
    const submitPeekReply = createPeekReplySubmitter({
      async fetcher(_url, _traceLabel, options) {
        calls.push(options);
        return { ok: true };
      },
      logger: noopLogger,
    });

    await submitPeekReply({
      projectName: "Project One",
      sessionName: "Session One",
      conversationId: "conv-one",
      text: "/collab Compare these approaches",
      collab: {
        negotiationRounds: 4,
        autonomousResolutionThreshold: "minor",
        agentTwo: {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "true", reasoning: "xhigh" },
          },
        },
      },
    });

    expect(calls[0]?.body).toBe(
      JSON.stringify({
        prompt: "/collab Compare these approaches",
        collab: {
          negotiationRounds: 4,
          autonomousResolutionThreshold: "minor",
          agentTwo: {
            backend: "codex",
            modelSelection: {
              modelId: "gpt-5.4",
              parameters: { fast: "true", reasoning: "xhigh" },
            },
          },
        },
      }),
    );
  });

  it("rejects with the ApiCallError raised by the fetcher", async () => {
    const error = new ApiCallError("Conversation is busy", "CONVERSATION_BUSY");
    const submitPeekReply = createPeekReplySubmitter({
      async fetcher() {
        throw error;
      },
      logger: noopLogger,
    });

    const result = submitPeekReply({
      projectName: "Project One",
      sessionName: "Session One",
      conversationId: "conv-one",
      text: "Hello",
    });

    await expect(result).rejects.toBe(error);
    expect(error).toBeInstanceOf(ApiCallError);
  });
});

describe("usePeekReply", () => {
  const fetchSpy = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
    useCollaborationStore.setState({ collabConfigDraftsByConversation: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useCollaborationStore.setState({ collabConfigDraftsByConversation: {} });
  });

  it("invalidates the peek transcript and active conversations after a reply", async () => {
    const client = makeClient();
    const messagesKey = conversationKeys.messages("p", "s", "c1");
    const activeKey = conversationKeys.active();
    client.setQueryData(messagesKey, []);
    client.setQueryData(activeKey, { conversations: [] });
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    const { result } = renderHook(
      () =>
        usePeekReply({
          projectName: "p",
          sessionName: "s",
          conversationId: "c1",
        }),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({ text: "hello" }),
    ).resolves.toEqual({ ok: true });

    await waitFor(() => {
      expect(client.getQueryState(messagesKey)?.isInvalidated).toBe(true);
      expect(client.getQueryState(activeKey)?.isInvalidated).toBe(true);
    });
  });

  it("clears only a successfully submitted collaboration draft", async () => {
    const client = makeClient();
    const collaborationListKey = collaborationKeys.list("p", "s");
    const draft = {
      agentTwo: {
        backend: "codex" as const,
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
      },
      negotiationRounds: 4,
      autonomousResolutionThreshold: "minor" as const,
    };
    useCollaborationStore.setState({
      collabConfigDraftsByConversation: {
        "p::s::c1": draft,
        "p::s::ordinary": draft,
      },
    });
    client.setQueryData(collaborationListKey, []);
    fetchSpy.mockResolvedValue(new Response(null, { status: 200 }));

    const { result } = renderHook(
      () =>
        usePeekReply({
          projectName: "p",
          sessionName: "s",
          conversationId: "c1",
        }),
      { wrapper: wrapperFor(client) },
    );

    await result.current.mutateAsync({
      text: "/collab compare",
      collab: {
        negotiationRounds: 4,
        autonomousResolutionThreshold: "minor",
        agentTwo: {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "false", reasoning: "high" },
          },
        },
      },
      collabDraft: draft,
    });

    expect(
      useCollaborationStore.getState().collabConfigDraftsByConversation,
    ).toEqual({ "p::s::ordinary": draft });
    await waitFor(() => {
      expect(client.getQueryState(collaborationListKey)?.isInvalidated).toBe(
        true,
      );
    });
  });

  it("preserves collaboration settings changed while submission is pending", async () => {
    const client = makeClient();
    const submittedDraft = {
      agentTwo: {
        backend: "codex" as const,
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
      },
      negotiationRounds: 4,
      autonomousResolutionThreshold: "minor" as const,
    };
    const nextDraft = {
      ...submittedDraft,
      agentTwo: {
        ...submittedDraft.agentTwo,
        modelSelection: {
          ...submittedDraft.agentTwo.modelSelection,
          parameters: {
            ...submittedDraft.agentTwo.modelSelection.parameters,
            fast: "true",
          },
        },
      },
    };
    useCollaborationStore.setState({
      collabConfigDraftsByConversation: { "p::s::c1": submittedDraft },
    });
    let resolveFetch!: (response: Response) => void;
    fetchSpy.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { result } = renderHook(
      () =>
        usePeekReply({
          projectName: "p",
          sessionName: "s",
          conversationId: "c1",
        }),
      { wrapper: wrapperFor(client) },
    );

    const submission = result.current.mutateAsync({
      text: "/collab compare",
      collab: {
        negotiationRounds: 4,
        autonomousResolutionThreshold: "minor",
        agentTwo: {
          backend: "codex",
          modelSelection: {
            modelId: "gpt-5.4",
            parameters: { fast: "false", reasoning: "high" },
          },
        },
      },
      collabDraft: submittedDraft,
    });
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));

    useCollaborationStore
      .getState()
      .setCollabConfigDraft("p", "s", "c1", nextDraft);
    resolveFetch(new Response(null, { status: 200 }));
    await submission;

    expect(
      useCollaborationStore.getState().collabConfigDraftsByConversation[
        "p::s::c1"
      ],
    ).toEqual(nextDraft);
  });

  it("preserves the collaboration draft when submission fails", async () => {
    const client = makeClient();
    const draft = {
      agentTwo: {
        backend: "codex" as const,
        modelSelection: {
          modelId: "gpt-5.4",
          parameters: { fast: "false", reasoning: "high" },
        },
      },
      negotiationRounds: 4,
      autonomousResolutionThreshold: "minor" as const,
    };
    useCollaborationStore.setState({
      collabConfigDraftsByConversation: { "p::s::c1": draft },
    });
    fetchSpy.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(
      () =>
        usePeekReply({
          projectName: "p",
          sessionName: "s",
          conversationId: "c1",
        }),
      { wrapper: wrapperFor(client) },
    );

    await expect(
      result.current.mutateAsync({
        text: "/collab compare",
        collab: { agentTwo: { backend: "codex" } },
        collabDraft: draft,
      }),
    ).rejects.toThrow("offline");
    expect(
      useCollaborationStore.getState().collabConfigDraftsByConversation,
    ).toEqual({ "p::s::c1": draft });
  });
});
