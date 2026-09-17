import { describe, expect, it } from "vitest";

import { runCcWithHost } from "@/cli/testing/domain-runtime";
import type { CliEnv, CliHost } from "@/cli/transport";
import {
  attachmentRefreshCommand,
  conversationReadCommands,
} from "./attachment-commands";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("ticket attachment commands", () => {
  it("shell-quotes both coordinates in the canonical refresh command", () => {
    expect(
      attachmentRefreshCommand("source project#12", "attachment one"),
    ).toBe(
      "cctl ticket attachment refresh 'source project#12' 'attachment one'",
    );
  });
});

describe("ticket attachment conversation commands", () => {
  it("shell-quotes source coordinates so generated commands stay executable", () => {
    expect(
      conversationReadCommands("conversation $(unsafe)", {
        projectName: "source project",
        sessionName: "Feature work; don't run",
      }),
    ).toEqual([
      "cctl conversation compaction get 'conversation $(unsafe)' --project 'source project' --session 'Feature work; don'\"'\"'t run'",
      "cctl conversation read 'conversation $(unsafe)' --outline --project 'source project' --session 'Feature work; don'\"'\"'t run'",
      "cctl conversation read 'conversation $(unsafe)' --message-range A:B --project 'source project' --session 'Feature work; don'\"'\"'t run'",
    ]);
  });

  it("overrides a ticket session's ambient scope for a project conversation", async () => {
    const conversationId = "project-conversation";
    const commands = conversationReadCommands(conversationId, {
      projectName: "source-project",
      sessionName: null,
    });
    const outlineCommand = commands[1];
    if (outlineCommand === undefined) {
      throw new Error("expected an outline retrieval command");
    }
    expect(outlineCommand).toBe(
      "cctl conversation read 'project-conversation' --outline --project 'source-project'",
    );

    const requests: string[] = [];
    const host: CliHost = {
      async fetch(url) {
        requests.push(url);
        if (url.includes("/context-artifacts")) return jsonResponse([]);
        return jsonResponse({
          conversationId,
          totalMessages: 0,
          maxSeq: 0,
          units: [],
          truncated: false,
          boundaries: {
            entries: [],
            totalInRange: 0,
            nextBefore: null,
            indexCommand: null,
          },
          truncation: {
            omittedAfter: null,
            partialEntry: null,
            excerptedEntries: [],
            excerptedEntriesOmitted: 0,
            excerptedEntriesNext: null,
          },
          omissions: {
            thinkingOmitted: 0,
            toolResultBytesElided: 0,
            unitsOutsideWindow: 0,
          },
        });
      },
      async readTextFile() {
        return null;
      },
      async readFileBytes() {
        return null;
      },
      async sleep() {},
      platform: "darwin",
      homedir: "/Users/test",
    };
    const ticketSessionEnv: CliEnv = {
      CC_SERVER_URL: "http://127.0.0.1:3000",
      CC_API_TOKEN: "token",
      CC_PROJECT: "ticket-project",
      CC_SESSION: "ticket-session",
      CC_CONVERSATION_ID: "ticket-conversation",
    };

    const result = await runCcWithHost(
      [
        "conversation",
        "read",
        conversationId,
        "--outline",
        "--project",
        "source-project",
      ],
      ticketSessionEnv,
      host,
    );

    expect(result.exitCode).toBe(0);
    expect(new URL(requests[0] ?? "").pathname).toBe(
      "/api/projects/source-project/conversations/project-conversation/read",
    );
    expect(requests.some((url) => url.includes("/api/conversations/"))).toBe(
      false,
    );
  });
});
