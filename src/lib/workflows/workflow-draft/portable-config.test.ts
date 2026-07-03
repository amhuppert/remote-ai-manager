import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("workflow-draft/portable-config", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.CC_SERVER_URL = "http://cc.local:4123/";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("builds the workflow draft portable MCP config", async () => {
    const { buildWorkflowDraftPortableMcp } = await import("./portable-config");

    expect(buildWorkflowDraftPortableMcp("my-project", "draft-1")).toEqual({
      servers: [
        {
          id: "cc-workflow-draft",
          transport: "streamable-http",
          url: "http://cc.local:4123/api/projects/my-project/workflows/generate/mcp/draft-1",
          headers: {
            Authorization: expect.stringMatching(/^Bearer /),
          },
        },
      ],
    });
  });
});
