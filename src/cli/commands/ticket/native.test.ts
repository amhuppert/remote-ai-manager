import { describe, expect, it } from "vitest";
import { createTestHost, runForTest } from "cli-for-agents/testing";
import { encodeTicketKeysetCursor } from "@/lib/tickets/ticket-keyset-cursor";
import { createCommandCenterCli } from "../../framework/application";
import type { CliHost, FetchInit } from "../../transport";
import {
  sampleDetail as ticket,
  sampleListItem,
  sampleRelationship as relation,
  sampleStatusUpdate as update,
} from "./native-fixtures";

const env = {
  CC_SERVER_URL: "http://cc.test",
  CC_API_TOKEN: "token",
  CC_PROJECT: "cc",
  CC_CONVERSATION_ID: "actor-one",
  CC_SESSION: "current-session",
  CC_CONVERSATION_SCOPE: "session",
};
const attachment = {
  id: "attachment-one",
  ticketId: ticket.id,
  description: "Mechanism",
  payload: { kind: "note", markdown: "Literal bytes." },
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
};
const transfer = {
  id: "af4557f1-bbb6-4eb7-8be7-95f1dd551752",
  mode: "export",
  status: "ready",
  title: ticket.title,
  documentCount: 1,
  omissions: [],
  digest: "sha",
  error: null,
  ticketNumber: 12,
};
function fixture(
  respond: unknown | ((url: string, init: FetchInit) => unknown),
  files: Record<string, string | Uint8Array> = {},
  status = 200,
) {
  const requests: Array<{ url: string; init: FetchInit }> = [];
  const host: CliHost = {
    async fetch(url, init) {
      requests.push({ url, init });
      return new Response(
        JSON.stringify(
          typeof respond === "function" ? respond(url, init) : respond,
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      throw new Error("Binary input belongs to the runtime host");
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
  const runtimeHost = createTestHost({
    files: { "/artifacts/.keep": "", ...files },
  });
  return {
    requests,
    runtimeHost,
    run: (
      argv: string[],
      overrides: Record<string, string> = {},
      format: "json" | "text" = "json",
    ) =>
      runForTest(
        createCommandCenterCli(host, {
          artifacts: { directory: "/artifacts", forbiddenRoots: [] },
        }),
        ["ticket", ...argv],
        { host: runtimeHost, env: { ...env, ...overrides }, format },
      ),
  };
}

describe("native ticket commands", () => {
  it.each([
    {
      args: [
        "create",
        "--title",
        "Fix gate",
        "--type",
        "bug",
        "--description",
        "Literal `ticks` $HOME",
      ],
      response: { ticket, warnings: [] },
      method: "POST",
      suffix: "",
      body: {
        title: "Fix gate",
        workType: "bug",
        description: "Literal `ticks` $HOME",
      },
    },
    {
      args: ["list", "--status", "not_started"],
      response: [sampleListItem],
      method: "GET",
      suffix: "?status=not_started",
    },
    { args: ["get", "12"], response: ticket, method: "GET", suffix: "/12" },
    {
      args: ["update", "12", "--status", "done"],
      response: ticket,
      method: "PATCH",
      suffix: "/12",
      body: { status: "done" },
    },
    {
      args: ["delete", "12"],
      response: ticket,
      method: "DELETE",
      suffix: "/12",
    },
    {
      args: [
        "start",
        "12",
        "--mode",
        "prepared",
        "--model",
        "model-one",
        "--model-param",
        "effort=high",
      ],
      response: {
        ticket,
        sessionName: "new-session",
        conversationId: "new-conversation",
        initialPromptQueued: false,
      },
      method: "POST",
      suffix: "/12/start",
      body: {
        mode: "prepared",
        modelSelection: {
          modelId: "model-one",
          parameters: { effort: "high" },
        },
      },
    },
    {
      args: ["relation", "list", "12", "--role", "depends_on", "--limit", "5"],
      response: { items: [relation], total: 1, nextCursor: null },
      method: "GET",
      suffix: "/12/relationships?limit=5&role=depends_on",
    },
    {
      args: ["relation", "get", "12", "rel-1"],
      response: relation,
      method: "GET",
      suffix: "/12/relationships/rel-1",
    },
    {
      args: [
        "relation",
        "add",
        "12",
        "other#7",
        "--role",
        "depends_on",
        "--description",
        "Literal `ticks` $HOME",
      ],
      response: { relationship: relation, tickets: [ticket] },
      method: "POST",
      suffix: "/12/relationships",
      body: {
        target: { projectName: "other", number: 7 },
        role: "depends_on",
        description: "Literal `ticks` $HOME",
      },
    },
    {
      args: [
        "relation",
        "update",
        "12",
        "rel-1",
        "--description",
        "Revised rationale",
      ],
      response: { relationship: relation, tickets: [ticket] },
      method: "PATCH",
      suffix: "/12/relationships/rel-1",
      body: { description: "Revised rationale" },
    },
    {
      args: ["relation", "remove", "12", "rel-1"],
      response: { relationshipId: "rel-1", tickets: [ticket] },
      method: "DELETE",
      suffix: "/12/relationships/rel-1",
    },
    {
      args: ["status-update", "add", "12", "--body", "Literal `ticks` $HOME"],
      response: { update, ticket },
      method: "POST",
      suffix: "/12/status-updates",
      body: { bodyMarkdown: "Literal `ticks` $HOME" },
    },
    {
      args: ["status-update", "list", "12", "--limit", "5"],
      response: { items: [update], total: 1, nextCursor: null },
      method: "GET",
      suffix: "/12/status-updates?limit=5",
    },
    {
      args: ["status-update", "get", "12", "update-1"],
      response: update,
      method: "GET",
      suffix: "/12/status-updates/update-1",
    },
    {
      args: [
        "attach",
        "note",
        "12",
        "--markdown",
        "Literal `ticks` $HOME",
        "--description",
        "Mechanism",
      ],
      response: attachment,
      method: "POST",
      suffix: "/12/attachments",
      body: {
        description: "Mechanism",
        payload: { kind: "note", markdown: "Literal `ticks` $HOME" },
      },
    },
    {
      args: [
        "attach",
        "conversation",
        "12",
        "other-conversation",
        "--description",
        "Mechanism",
      ],
      response: attachment,
      method: "POST",
      suffix: "/12/attachments",
      body: {
        description: "Mechanism",
        payload: {
          kind: "conversation",
          projectName: "cc",
          sessionName: null,
          conversationId: "other-conversation",
        },
      },
    },
    {
      args: [
        "attach",
        "session",
        "12",
        "old-session",
        "--description",
        "Mechanism",
      ],
      response: attachment,
      method: "POST",
      suffix: "/12/attachments",
      body: {
        description: "Mechanism",
        payload: {
          kind: "session",
          projectName: "cc",
          sessionName: "old-session",
        },
      },
    },
    {
      args: ["attachment", "get", "12", "attachment-one"],
      response: { kind: "note", attachment, markdown: "Literal bytes." },
      method: "GET",
      suffix: "/12/attachments/attachment-one",
    },
    {
      args: [
        "attachment",
        "update",
        "12",
        "attachment-one",
        "--description",
        "Revised",
      ],
      response: attachment,
      method: "PATCH",
      suffix: "/12/attachments/attachment-one",
      body: { description: "Revised" },
    },
    {
      args: ["attachment", "refresh", "12", "attachment-one"],
      response: attachment,
      method: "POST",
      suffix: "/12/attachments/attachment-one/refresh-snapshot",
    },
    {
      args: ["attachment", "remove", "12", "attachment-one"],
      response: {
        attachmentId: "attachment-one",
        ticketId: ticket.id,
        kind: "note",
        ticketUpdatedAt: ticket.updatedAt,
      },
      method: "DELETE",
      suffix: "/12/attachments/attachment-one",
    },
  ])(
    "runs $args from static definitions to the domain route",
    async ({ args, response, method, suffix, body }) => {
      const test = fixture(response);
      const result = await test.run(args);
      expect(result.exitCode, result.stdout).toBe(0);
      expect(test.requests[0]?.url).toBe(
        `http://cc.test/api/projects/cc/tickets${suffix}`,
      );
      expect(test.requests[0]?.init.method).toBe(method);
      if (body)
        expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual(body);
      if (args[0] === "status-update" && args[1] === "add")
        expect(test.requests[0]?.init.headers["x-cc-conversation-id"]).toBe(
          "actor-one",
        );
    },
  );

  it("resolves qualified references and all-project lists without an ambient project", async () => {
    const read = fixture({ ...ticket, projectName: "elsewhere" });
    const result = await read.run(["get", "elsewhere#12"], { CC_PROJECT: "" });
    expect(result.exitCode, result.stdout).toBe(0);
    expect(read.requests[0]?.url).toContain(
      "/api/projects/elsewhere/tickets/12",
    );
    const list = fixture([sampleListItem]);
    expect(
      (await list.run(["list", "--all"], { CC_PROJECT: "" })).exitCode,
    ).toBe(0);
    expect(list.requests[0]?.url).toBe("http://cc.test/api/tickets");
  });

  it("enforces actor provenance and model parameter admission before requests", async () => {
    const test = fixture(ticket);
    expect(
      (
        await test.run([
          "status-update",
          "add",
          "12",
          "--body",
          "claim",
          "--conversation",
          "someone-else",
        ])
      ).exitCode,
    ).toBe(2);
    expect(
      (
        await test.run(["status-update", "add", "12", "--body", "claim"], {
          CC_CONVERSATION_ID: "",
        })
      ).exitCode,
    ).toBe(2);
    expect(
      (
        await test.run([
          "start",
          "12",
          "--mode",
          "agent",
          "--model-param",
          "effort=high",
        ])
      ).exitCode,
    ).toBe(2);
    expect((await test.run(["get", "9007199254740993"])).exitCode).toBe(2);
    expect(test.requests).toHaveLength(0);
  });

  it("retains semantic relationship refusals as exit 1 with server instructions", async () => {
    const test = fixture(
      {
        error: "Cycle refused",
        code: "relationship_cycle",
        instruction: "Remove the cycle before adding this link.",
        details: { cycle: ["cc#12", "other#7"] },
      },
      {},
      400,
    );
    const result = await test.run([
      "relation",
      "add",
      "12",
      "other#7",
      "--role",
      "depends_on",
    ]);
    expect(result.exitCode, result.stdout).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      effect: "not_applied",
      instruction: "Remove the cycle before adding this link.",
      error: { details: { serverCode: "relationship_cycle" } },
    });
  });

  it("uploads arbitrary file bytes through the library host and multipart transport", async () => {
    const content = new Uint8Array([0, 255, 13, 10, 19]);
    const test = fixture(attachment, { "/input/image.bin": content });
    const result = await test.run([
      "attach",
      "file",
      "12",
      "/input/image.bin",
      "--description",
      "Binary evidence",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const request = test.requests[0];
    expect(request?.init.headers["content-type"]).toContain(
      "multipart/form-data; boundary=",
    );
    expect(request?.init.body).toBeUndefined();
    expect(request?.init.rawBody).toBeInstanceOf(Uint8Array);
  });

  it("exports a prepared bundle to exact archive bytes", async () => {
    const archive = Buffer.from([80, 75, 0, 255]);
    const test = fixture((url: string) =>
      url.includes("/download?")
        ? { archive: archive.toString("base64") }
        : transfer,
    );
    const result = await test.run([
      "export",
      "12",
      "--prepared",
      transfer.id,
      "--out",
      "/artifacts/ticket.gz",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(
      Buffer.from(
        test.runtimeHost.filesSnapshot()["/artifacts/ticket.gz"] ?? [],
      ),
    ).toEqual(archive);
  });

  it("imports a local bundle using the server's prepared transfer and digest", async () => {
    const archive = Buffer.from([80, 75, 0, 255]);
    const test = fixture(
      (url: string) => ({
        ...transfer,
        mode: "import",
        status: url.endsWith("/import") ? "imported" : "ready",
      }),
      { "/input/ticket.gz": archive },
    );
    const result = await test.run(["import", "--archive", "/input/ticket.gz"]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(JSON.parse(test.requests[0]?.init.body ?? "null")).toEqual({
      archive: archive.toString("base64"),
    });
    expect(JSON.parse(test.requests[1]?.init.body ?? "null")).toEqual({
      digest: "sha",
      allowDuplicate: false,
    });
  });
  it("keeps role and source identity in a relationship cursor continuation", async () => {
    const nextCursor = encodeTicketKeysetCursor({
      timestamp: relation.updatedAt,
      id: relation.id,
    });
    const test = fixture({ items: [relation], total: 3, nextCursor });
    const result = await test.run([
      "relation",
      "list",
      "cc#12",
      "--role",
      "depends_on",
      "--limit",
      "1",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    const data = JSON.parse(result.stdout).payload.data;
    expect(data.omission).toMatchObject({
      truncated: true,
      returned: 1,
      total: { kind: "known", count: 3 },
    });
    expect(data.revealCommand).toContain("--role=depends_on");
    expect(data.revealCommand).toContain(`--cursor=${nextCursor}`);
    expect(data.relationships[0].descriptionPreview).toBe(relation.description);
    const bad = await test.run([
      "relation",
      "list",
      "12",
      "--cursor",
      "malformed",
    ]);
    expect(bad.exitCode).toBe(2);
    expect(test.requests).toHaveLength(1);
  });

  it("refuses a prepared export's missing-content gate before downloading or claiming a write", async () => {
    const test = fixture({
      ...transfer,
      omissions: [
        { source: "conversation:gone", reason: "No retained snapshot" },
      ],
    });
    const result = await test.run(["export", "12", "--prepared", transfer.id]);
    expect(result.exitCode, result.stdout).toBe(1);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.effect).toBe("not_applied");
    expect(envelope.error.details).toMatchObject({
      transferId: transfer.id,
      digest: "sha",
      omissions: [{ source: "conversation:gone" }],
    });
    expect(envelope.hint).toContain(`--prepared=${transfer.id}`);
    expect(envelope.hint).toContain("--acknowledge=sha");
    expect(test.requests).toHaveLength(1);
  });

  it("returns a binary attachment as exact bytes and rejects inconsistent declared size", async () => {
    const content = Buffer.from([0, 255, 10, 17]);
    const file = {
      ...attachment,
      payload: {
        kind: "file",
        fileName: "evidence.bin",
        snapshotKey: "snapshot-one",
        mediaType: "application/octet-stream",
        sizeBytes: content.length,
        sha256: "sha",
      },
    };
    const body = {
      kind: "file",
      attachment: file,
      fileName: "evidence.bin",
      mediaType: "application/octet-stream",
      sizeBytes: content.length,
      sha256: "sha",
      encoding: "base64",
      content: content.toString("base64"),
    };
    const test = fixture(body);
    const result = await test.run([
      "attachment",
      "get",
      "12",
      file.id,
      "--out",
      "/artifacts/evidence.bin",
    ]);
    expect(result.exitCode, result.stdout).toBe(0);
    expect(
      Buffer.from(
        test.runtimeHost.filesSnapshot()["/artifacts/evidence.bin"] ?? [],
      ),
    ).toEqual(content);
    const corrupt = fixture({ ...body, sizeBytes: 50 });
    expect(
      (await corrupt.run(["attachment", "get", "12", file.id])).exitCode,
    ).toBe(1);
    expect(corrupt.runtimeHost.filesSnapshot()).toEqual({
      "/artifacts/.keep": new Uint8Array(),
    });
  });

  it("only enriches retained list rows and returns the exact broader list command", async () => {
    const test = fixture((url: string) =>
      url.endsWith("/attachments")
        ? { attachments: [attachment] }
        : [
            { ...sampleListItem, attachmentCount: 1 },
            {
              ...sampleListItem,
              id: "ticket-2",
              number: 13,
              attachmentCount: 1,
            },
          ],
    );
    const result = await test.run(
      ["list", "--attachments", "--limit", "1", "--sort", "updated"],
      {},
      "text",
    );
    expect(result.exitCode, result.stdout).toBe(0);
    expect(test.requests).toHaveLength(2);
    expect(result.stdout).toContain("--attachments");
    expect(result.stdout).toContain("--limit=2");
    expect(result.stdout).toContain("--sort=updated");
    expect(result.stdout).toContain("attachment-one");
  });

  it.each(["create", "update", "attach"])(
    "omits stored prose from %s mutation receipts",
    async (operation) => {
      const prose = "PRIVATE_MARKDOWN_TAIL ".repeat(4000);
      const largeTicket = { ...ticket, description: prose };
      const test = fixture(
        operation === "create"
          ? { ticket: largeTicket, warnings: [] }
          : operation === "update"
            ? largeTicket
            : {
                ...attachment,
                description: prose,
                payload: { kind: "note", markdown: prose },
              },
      );
      const result = await test.run(
        operation === "create"
          ? ["create", "--title", "Fix", "--type", "bug"]
          : operation === "update"
            ? ["update", "12", "--status", "done"]
            : [
                "attach",
                "note",
                "12",
                "--description",
                "Context",
                "--markdown",
                "Note",
              ],
      );
      expect(result.exitCode, result.stdout).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        effect: "applied",
      });
      expect(result.stdout).not.toContain(prose);
      expect(result.stdout).toContain("cctl ticket");
    },
  );
});
