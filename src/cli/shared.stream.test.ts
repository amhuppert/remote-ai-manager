import { describe, expect, it } from "vitest";
import { cliRequestStream, type CliHost, type FetchInit } from "./transport";
function host(response: Response) {
  const requests: FetchInit[] = [];
  const value: CliHost = {
    async fetch(_url, init) {
      requests.push(init);
      return response;
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
  return { value, requests };
}
const params = {
  server: "http://cc.test",
  path: "/prompt",
  method: "POST",
  token: null,
  tokenSource: null,
  unstamped: true,
  body: { prompt: "hello" },
} as const;
describe("CLI streaming transport", () => {
  it("returns the untouched success response for incremental stream consumption", async () => {
    const response = new Response("event: done\ndata: {}\n\n");
    const test = host(response);
    const result = await cliRequestStream(test.value, params);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") throw new Error("Expected streaming success");
    expect(result.response).toBe(response);
    expect(result.response.bodyUsed).toBe(false);
    expect(test.requests[0]?.headers["x-cc-cli-build"]).toBeUndefined();
    expect(await result.response.text()).toContain("event: done");
  });
  it("preserves canonical refusal instructions, rationale, issue location, and detail", async () => {
    const response = new Response(
      JSON.stringify({
        error: "Not allowed",
        code: "refused",
        instruction: "Stop here.",
        rationale: "Approval is required.",
        details: { phase: "draft" },
        issues: [
          { path: "input.body", message: "refused", recordId: "row-one" },
        ],
      }),
      { status: 403 },
    );
    const test = host(response);
    expect(await cliRequestStream(test.value, params)).toMatchObject({
      kind: "error",
      status: 403,
      instruction: "Stop here.",
      rationale: "Approval is required.",
      details: { phase: "draft" },
      issues: [{ path: "input.body", recordId: "row-one" }],
    });
  });
});
