import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  jsonError,
  notFound,
  resolveProjectOr404,
  resolveProjectSessionOr404,
  parseJsonBody,
} from "./route-resolution";
import type { ApiError } from "@/lib/api/errors";

function jsonRequest(body?: unknown): Request {
  return new Request("http://cc.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("jsonError", () => {
  it("builds a JSON error Response with the given status", async () => {
    const response = jsonError("nope", 418);
    expect(response.status).toBe(418);
    const body = (await response.json()) as ApiError;
    expect(body.error).toBe("nope");
  });

  it("carries an optional machine-readable code", async () => {
    const response = jsonError("nope", 418, "teapot");
    const body = (await response.json()) as ApiError;
    expect(body).toEqual({ error: "nope", code: "teapot" });
  });

  it("omits the code key entirely when no code is given", async () => {
    const body = (await jsonError("nope", 418).json()) as ApiError;
    expect("code" in body).toBe(false);
  });
});

describe("notFound", () => {
  it("builds a 404 JSON error Response with the given message", async () => {
    const response = notFound("Workflow not found");
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiError;
    expect(body.error).toBe("Workflow not found");
  });

  it("carries an optional machine-readable code", async () => {
    const response = notFound(
      "Conversation not found",
      "conversation_not_found",
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as ApiError;
    expect(body).toEqual({
      error: "Conversation not found",
      code: "conversation_not_found",
    });
  });

  it("carries optional structured details without changing the flat error shape", async () => {
    const response = notFound("Attachment not found", "attachment_not_found", {
      attachmentId: "attachment-1",
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Attachment not found",
      code: "attachment_not_found",
      details: { attachmentId: "attachment-1" },
    });
  });
});

describe("resolveProjectSessionOr404", () => {
  const session = { worktreePath: "/repos/demo/.worktrees/s1" };
  const deps = {
    resolveProjectPath: async (name: string) =>
      name === "demo" ? "/repos/demo" : null,
    getSession: async (_projectPath: string, sessionName: string) =>
      sessionName === "s1" ? session : null,
  };

  it("resolves project path and session together", async () => {
    const result = await resolveProjectSessionOr404(deps, "demo", "s1");
    expect(result).toEqual({
      ok: true,
      value: { projectPath: "/repos/demo", session },
    });
  });

  it("returns the project 404 when the project is unknown", async () => {
    const result = await resolveProjectSessionOr404(deps, "missing", "s1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      const body = (await result.response.json()) as ApiError;
      expect(body.error).toBe("Project not found");
    }
  });

  it("returns a session 404 when the session is unknown", async () => {
    const result = await resolveProjectSessionOr404(deps, "demo", "missing");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      const body = (await result.response.json()) as ApiError;
      expect(body.error).toBe("Session not found");
    }
  });
});

describe("resolveProjectOr404", () => {
  it("resolves the project path when the name maps to a project", async () => {
    const result = await resolveProjectOr404(
      { resolveProjectPath: async () => "/repos/demo" },
      "demo",
    );
    expect(result).toEqual({ ok: true, value: "/repos/demo" });
  });

  it("returns a 404 Response when the name is unknown", async () => {
    const result = await resolveProjectOr404(
      { resolveProjectPath: async () => null },
      "missing",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(404);
      const body = (await result.response.json()) as ApiError;
      expect(body.error).toBe("Project not found");
    }
  });
});

describe("parseJsonBody", () => {
  const schema = z.object({ name: z.string().min(1) });

  it("returns the parsed value for a valid body", async () => {
    const result = await parseJsonBody(
      jsonRequest({ name: "fresh" }),
      schema,
      "name required",
    );
    expect(result).toEqual({ ok: true, value: { name: "fresh" } });
  });

  it("returns a 400 Response carrying errorMessage for an invalid body", async () => {
    const result = await parseJsonBody(
      jsonRequest({ name: "" }),
      schema,
      "name required",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(400);
      const body = (await result.response.json()) as ApiError;
      expect(body.error).toBe("name required");
    }
  });

  it("returns a 400 Response when the body is absent", async () => {
    const result = await parseJsonBody(jsonRequest(), schema, "name required");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(400);
  });
});
