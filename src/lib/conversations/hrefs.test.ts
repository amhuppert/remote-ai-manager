import { describe, it, expect } from "vitest";
import { conversationsPageHref, parseConversationsPageParams } from "./hrefs";

describe("conversationsPageHref", () => {
  it("returns plain /conversations with no opts", () => {
    expect(conversationsPageHref({})).toBe("/conversations");
  });

  it("builds ?c= for a conversation id", () => {
    expect(conversationsPageHref({ conversationId: "abc123" })).toBe(
      "/conversations?c=abc123",
    );
  });

  it("builds the project+session filter pair", () => {
    expect(
      conversationsPageHref({ projectName: "my-app", sessionName: "fix-bug" }),
    ).toBe("/conversations?project=my-app&session=fix-bug");
  });

  it("encodes names with spaces and slashes", () => {
    expect(
      conversationsPageHref({
        projectName: "my app",
        sessionName: "feat/a b",
      }),
    ).toBe("/conversations?project=my%20app&session=feat%2Fa%20b");
  });

  it("encodes the conversation id", () => {
    expect(conversationsPageHref({ conversationId: "a&b=c" })).toBe(
      "/conversations?c=a%26b%3Dc",
    );
  });

  it("appends autoFocus=true only when set", () => {
    expect(
      conversationsPageHref({ conversationId: "abc", autoFocus: true }),
    ).toBe("/conversations?c=abc&autoFocus=true");
    expect(
      conversationsPageHref({ conversationId: "abc", autoFocus: false }),
    ).toBe("/conversations?c=abc");
  });

  it("combines all params", () => {
    expect(
      conversationsPageHref({
        conversationId: "abc",
        projectName: "p",
        sessionName: "s",
        autoFocus: true,
      }),
    ).toBe("/conversations?c=abc&project=p&session=s&autoFocus=true");
  });

  it("omits the filter pair when only one of project/session is provided", () => {
    expect(conversationsPageHref({ projectName: "p" })).toBe("/conversations");
    expect(conversationsPageHref({ sessionName: "s" })).toBe("/conversations");
  });
});

describe("parseConversationsPageParams", () => {
  it("parses an empty params set", () => {
    expect(parseConversationsPageParams(new URLSearchParams())).toEqual({
      conversationId: null,
      sessionFilter: null,
      autoFocus: false,
    });
  });

  it("parses the conversation id", () => {
    expect(
      parseConversationsPageParams(new URLSearchParams("c=abc123")),
    ).toEqual({
      conversationId: "abc123",
      sessionFilter: null,
      autoFocus: false,
    });
  });

  it("parses the session filter pair", () => {
    expect(
      parseConversationsPageParams(
        new URLSearchParams("project=my-app&session=fix-bug"),
      ),
    ).toEqual({
      conversationId: null,
      sessionFilter: { projectName: "my-app", sessionName: "fix-bug" },
      autoFocus: false,
    });
  });

  it("ignores a lone project or session param", () => {
    expect(
      parseConversationsPageParams(new URLSearchParams("project=my-app")),
    ).toEqual({ conversationId: null, sessionFilter: null, autoFocus: false });
    expect(
      parseConversationsPageParams(new URLSearchParams("session=fix-bug")),
    ).toEqual({ conversationId: null, sessionFilter: null, autoFocus: false });
  });

  it("parses autoFocus only for the literal true", () => {
    expect(
      parseConversationsPageParams(new URLSearchParams("autoFocus=true"))
        .autoFocus,
    ).toBe(true);
    expect(
      parseConversationsPageParams(new URLSearchParams("autoFocus=false"))
        .autoFocus,
    ).toBe(false);
    expect(
      parseConversationsPageParams(new URLSearchParams("autoFocus=")).autoFocus,
    ).toBe(false);
  });

  it("round-trips build → parse for every param combination", () => {
    const cases = [
      {},
      { conversationId: "abc123" },
      { conversationId: "abc123", autoFocus: true },
      { projectName: "my app", sessionName: "feat/a b" },
      {
        conversationId: "a&b=c",
        projectName: "p name",
        sessionName: "s/name",
        autoFocus: true,
      },
    ];

    for (const opts of cases) {
      const href = conversationsPageHref(opts);
      const query = href.includes("?") ? href.slice(href.indexOf("?") + 1) : "";
      const parsed = parseConversationsPageParams(new URLSearchParams(query));
      expect(parsed.conversationId).toBe(opts.conversationId ?? null);
      expect(parsed.autoFocus).toBe(opts.autoFocus ?? false);
      if (opts.projectName !== undefined && opts.sessionName !== undefined) {
        expect(parsed.sessionFilter).toEqual({
          projectName: opts.projectName,
          sessionName: opts.sessionName,
        });
      } else {
        expect(parsed.sessionFilter).toBeNull();
      }
    }
  });
});
