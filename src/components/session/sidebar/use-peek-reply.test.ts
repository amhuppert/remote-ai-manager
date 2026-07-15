// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiCallError } from "@/lib/api/errors";
import { conversationKeys } from "@/lib/conversations/query-keys";
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
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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
});
