import { expect, it } from "vitest";
import { runCli } from "../core";
import type { CliHost } from "../shared";

it("prints the exact prepared-bundle acknowledgment and never downloads an incomplete export without it", async () => {
  const requests: string[] = [];
  const id = "11111111-1111-4111-8111-111111111111";
  const host: CliHost = {
    async fetch(url) {
      requests.push(url);
      return Response.json({
        id,
        mode: "export",
        status: "ready",
        title: "Ticket",
        documentCount: 2,
        omissions: [
          { source: "conversation:gone", reason: "Transcript missing" },
        ],
        digest: "a".repeat(64),
        error: null,
        ticketNumber: null,
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
    homedir: "/test",
  };
  const result = await runCli(
    ["ticket", "export", "7", "--out", "ticket.gz"],
    {
      CC_SERVER_URL: "http://cc.test",
      CC_API_TOKEN: "test",
      CC_PROJECT: "repo",
    },
    host,
  );
  expect(result.stderr + result.stdout).toContain("conversation:gone");
  expect(result.stderr + result.stdout).toContain(`--prepared ${id}`);
  expect(result.stderr + result.stdout).toContain(
    `--acknowledge ${"a".repeat(64)}`,
  );
  expect(requests.every((url) => !url.includes("/download"))).toBe(true);
});
