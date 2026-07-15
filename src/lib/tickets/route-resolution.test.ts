import { describe, expect, it, vi } from "vitest";
import { resolveTicketProjectOr404 } from "./route-resolution";

describe("resolveTicketProjectOr404", () => {
  it("returns the resolved project path through the shared route-resolution contract", async () => {
    const resolveProjectPath = vi
      .fn()
      .mockResolvedValue("/repos/command-center");

    await expect(
      resolveTicketProjectOr404({ resolveProjectPath }, "command-center"),
    ).resolves.toEqual({ ok: true, value: "/repos/command-center" });
    expect(resolveProjectPath).toHaveBeenCalledWith("command-center");
  });

  it("preserves the ticket API project-not-found contract", async () => {
    const result = await resolveTicketProjectOr404(
      { resolveProjectPath: () => Promise.resolve(null) },
      "missing-project",
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(404);
    await expect(result.response.json()).resolves.toEqual({
      error: "Project not found: missing-project",
      code: "project_not_found",
    });
  });
});
