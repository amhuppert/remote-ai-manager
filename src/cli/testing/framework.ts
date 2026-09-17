import { createTestHost, runForTest } from "cli-for-agents/testing";
import type { CliEnv, CliHost, FetchInit } from "../transport";
import { createCommandCenterCli } from "../framework/application";

export interface CcTestRequest {
  url: string;
  init: FetchInit;
}

export function jsonReply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function createCcRuntimeFixture(options: {
  respond(request: CcTestRequest): Response | Promise<Response>;
  files?: Record<string, string>;
  env?: CliEnv;
}) {
  const requests: CcTestRequest[] = [];
  const files = options.files ?? {};
  const host: CliHost = {
    async fetch(url, init) {
      const request = { url, init };
      requests.push(request);
      return options.respond(request);
    },
    async readTextFile(filePath) {
      return files[filePath] ?? null;
    },
    async readFileBytes(filePath) {
      const content = files[filePath];
      return content === undefined ? null : new TextEncoder().encode(content);
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
  const kernelHost = createTestHost({
    files: { "/artifacts/.keep": "", ...files },
  });
  const cli = createCommandCenterCli(host, {
    artifacts: { directory: "/artifacts", forbiddenRoots: [] },
  });
  const env = {
    CC_SERVER_URL: "http://cc.test",
    CC_API_TOKEN: "test-token",
    CC_PROJECT: "project-one",
    CC_SESSION: "session-one",
    CC_CONVERSATION_ID: "conversation-one",
    ...options.env,
  };
  return {
    requests,
    host,
    kernelHost,
    cli,
    run(argv: string[], format: "text" | "json" = "json") {
      return runForTest(cli, argv, { host: kernelHost, env, format });
    },
  };
}
