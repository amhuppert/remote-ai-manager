import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createTicketProjectResolver } from "./project-resolver";

describe("ticket project resolution", () => {
  it("prefers the currently available project path", async () => {
    const listKnownProjectPaths = vi.fn(() => ["/old/command-center"]);
    const resolver = createTicketProjectResolver({
      resolveAvailableProjectPath: async () => "/repos/command-center",
      listKnownProjectPaths,
    });

    await expect(
      resolver.resolveKnownProjectPath("command-center"),
    ).resolves.toBe("/repos/command-center");
    expect(listKnownProjectPaths).not.toHaveBeenCalled();
  });

  it("resolves a retained project whose directory is currently missing", async () => {
    const resolver = createTicketProjectResolver({
      resolveAvailableProjectPath: async () => null,
      listKnownProjectPaths: () => ["/repos/other", "/repos/command-center"],
    });

    await expect(
      resolver.resolveKnownProjectPath("command-center"),
    ).resolves.toBe("/repos/command-center");
  });

  it("does not guess when retained project names are ambiguous", async () => {
    const resolver = createTicketProjectResolver({
      resolveAvailableProjectPath: async () => null,
      listKnownProjectPaths: () => [
        "/old/command-center",
        "/new/command-center",
      ],
    });

    await expect(
      resolver.resolveKnownProjectPath("command-center"),
    ).resolves.toBeNull();
  });
});
