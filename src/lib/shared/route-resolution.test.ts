import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  jsonError,
  resolveProjectOr404,
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
