import { describe, it, expect, vi } from "vitest";
import {
  createPortOwnershipService,
  isOwnedProcessCwd,
  isSameOrDescendantPath,
  listListeningPidsWithExec,
  normalizePath,
  parseLsofListenerOutput,
  parseSsListenerOutput,
  type PortOwnershipDeps,
} from "./dev-server-port-ownership";

function createTestDeps(
  overrides: Partial<PortOwnershipDeps> = {},
): PortOwnershipDeps {
  return {
    listListeningPids: vi.fn().mockResolvedValue([]),
    listAllListeningPorts: vi
      .fn()
      .mockResolvedValue(new Map<number, number[]>()),
    getProcessCwd: vi.fn().mockResolvedValue(null),
    realpath: vi.fn().mockImplementation(async (p: string) => p),
    ...overrides,
  };
}

describe("pure path helpers", () => {
  describe("normalizePath", () => {
    it("strips trailing slashes", () => {
      expect(normalizePath("/foo/bar/")).toBe("/foo/bar");
      expect(normalizePath("/foo/bar///")).toBe("/foo/bar");
    });

    it("preserves the root slash", () => {
      expect(normalizePath("/")).toBe("/");
    });

    it("collapses redundant segments", () => {
      expect(normalizePath("/foo//bar/./baz")).toBe("/foo/bar/baz");
    });
  });

  describe("isSameOrDescendantPath", () => {
    it("returns true when paths are equal", () => {
      expect(isSameOrDescendantPath("/foo/bar", "/foo/bar")).toBe(true);
    });

    it("returns true for descendants", () => {
      expect(isSameOrDescendantPath("/foo/bar/baz", "/foo/bar")).toBe(true);
      expect(isSameOrDescendantPath("/foo/bar/baz/qux", "/foo/bar")).toBe(true);
    });

    it("returns false for siblings sharing a prefix", () => {
      expect(isSameOrDescendantPath("/foo/barbaz", "/foo/bar")).toBe(false);
    });

    it("returns false when candidate is outside the parent", () => {
      expect(isSameOrDescendantPath("/var/log", "/foo/bar")).toBe(false);
    });

    it("returns false when either path is empty", () => {
      expect(isSameOrDescendantPath("", "/foo")).toBe(false);
      expect(isSameOrDescendantPath("/foo", "")).toBe(false);
    });

    it("normalizes trailing slashes before comparing", () => {
      expect(isSameOrDescendantPath("/foo/bar/", "/foo/bar")).toBe(true);
      expect(isSameOrDescendantPath("/foo/bar/baz/", "/foo/bar/")).toBe(true);
    });
  });

  describe("isOwnedProcessCwd", () => {
    it("returns true when cwd is the worktree root", () => {
      expect(isOwnedProcessCwd("/wt", "/wt")).toBe(true);
    });

    it("returns true when cwd is under worktree", () => {
      expect(isOwnedProcessCwd("/wt/app", "/wt")).toBe(true);
    });

    it("returns true when cwd is under allowedCwd", () => {
      expect(isOwnedProcessCwd("/other/app", "/wt", "/other")).toBe(true);
    });

    it("returns false when cwd is outside both worktree and allowedCwd", () => {
      expect(isOwnedProcessCwd("/var/run/other", "/wt", "/other")).toBe(false);
    });

    it("returns false when cwd is outside worktree and allowedCwd not provided", () => {
      expect(isOwnedProcessCwd("/var/run/other", "/wt")).toBe(false);
    });
  });
});

describe("createPortOwnershipService.classifyPort", () => {
  it("returns available when no listener exists on the port", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([]),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result).toEqual({ status: "available" });
    expect(deps.getProcessCwd).not.toHaveBeenCalled();
  });

  it("returns owned when listener cwd exactly equals the worktree path", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([12345]),
      getProcessCwd: vi.fn().mockResolvedValue("/wt"),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result).toEqual({ status: "owned", pid: 12345, cwd: "/wt" });
  });

  it("returns owned when listener cwd is a descendant directory under the worktree", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([54321]),
      getProcessCwd: vi.fn().mockResolvedValue("/wt/packages/web"),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result).toEqual({
      status: "owned",
      pid: 54321,
      cwd: "/wt/packages/web",
    });
  });

  it("returns owned when listener cwd is inside the configured allowedCwd", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([777]),
      getProcessCwd: vi.fn().mockResolvedValue("/configured/app/build"),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
      allowedCwd: "/configured/app",
    });

    expect(result).toEqual({
      status: "owned",
      pid: 777,
      cwd: "/configured/app/build",
    });
  });

  it("returns conflict when listener cwd resolves outside the session worktree", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([88888]),
      getProcessCwd: vi.fn().mockResolvedValue("/var/run/someone-elses-app"),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result).toEqual({
      status: "conflict",
      pid: 88888,
      cwd: "/var/run/someone-elses-app",
    });
  });

  it("returns unknown — never available — when listener cwd cannot be resolved", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([42]),
      getProcessCwd: vi.fn().mockResolvedValue(null),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result.status).toBe("unknown");
    if (result.status === "unknown") {
      expect(result.reason).toBeTruthy();
    }
  });

  it("returns owned when worktree and cwd point to the same real path through different symlinks", async () => {
    const realpath = vi.fn().mockImplementation(async (p: string) => {
      if (p === "/symlinked/wt") return "/real/wt";
      if (p === "/other/symlinked/wt/app") return "/real/wt/app";
      return p;
    });
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([5555]),
      getProcessCwd: vi.fn().mockResolvedValue("/other/symlinked/wt/app"),
      realpath,
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/symlinked/wt",
    });

    expect(result).toEqual({
      status: "owned",
      pid: 5555,
      cwd: "/other/symlinked/wt/app",
    });
  });

  it("returns unknown when the listener lookup itself fails", async () => {
    const deps = createTestDeps({
      listListeningPids: vi
        .fn()
        .mockRejectedValue(new Error("ss/lsof unavailable")),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result.status).toBe("unknown");
  });

  it("prefers owned over conflict when multiple listeners are present", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([111, 222]),
      getProcessCwd: vi.fn().mockImplementation(async (pid: number) => {
        if (pid === 111) return "/var/run/other";
        if (pid === 222) return "/wt/app";
        return null;
      }),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result.status).toBe("owned");
    if (result.status === "owned") {
      expect(result.pid).toBe(222);
    }
  });
});

describe("production listener PID lookup", () => {
  it("treats lsof exit status 1 as no listener when ss is unavailable", async () => {
    const exec = vi.fn((command: string) => {
      const error = new Error("not found") as Error & { status: number };
      error.status = command.startsWith("ss ") ? 127 : 1;
      throw error;
    });

    await expect(listListeningPidsWithExec(65000, exec)).resolves.toEqual([]);
  });

  it("still throws when neither ss nor lsof can run", async () => {
    const exec = vi.fn(() => {
      const error = new Error("missing") as Error & { status: number };
      error.status = 127;
      throw error;
    });

    await expect(listListeningPidsWithExec(65000, exec)).rejects.toThrow(
      /unusable/,
    );
  });
});

describe("parseSsListenerOutput", () => {
  it("parses local addr port and pid from a typical ss row", () => {
    const out =
      'LISTEN 0      511                0.0.0.0:3000                  0.0.0.0:*    users:(("next-server",pid=1234,fd=23))\n' +
      'LISTEN 0      511                127.0.0.1:6006                0.0.0.0:*    users:(("storybook",pid=5678,fd=15))\n';
    const result = parseSsListenerOutput(out);
    expect(result.get(3000)).toEqual([1234]);
    expect(result.get(6006)).toEqual([5678]);
  });

  it("handles IPv6 by taking the port after the last colon", () => {
    const out =
      'LISTEN 0      128                [::]:8080                     [::]:*       users:(("app",pid=42,fd=3))\n';
    expect(parseSsListenerOutput(out).get(8080)).toEqual([42]);
  });

  it("returns an empty map for unparseable output", () => {
    expect(parseSsListenerOutput("").size).toBe(0);
    expect(parseSsListenerOutput("garbage with no pid").size).toBe(0);
  });

  it("merges multiple PIDs listening on the same port without duplicates", () => {
    const out =
      'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("a",pid=1,fd=1),("b",pid=2,fd=2))\n' +
      'LISTEN 0 511 0.0.0.0:3000 0.0.0.0:* users:(("a",pid=1,fd=1))\n';
    expect(parseSsListenerOutput(out).get(3000)).toEqual([1, 2]);
  });
});

describe("parseLsofListenerOutput", () => {
  it("parses pid/name pairs from -F pPn output", () => {
    const out = "p1234\nPnode\nn*:3000\np5678\nPnode\nn127.0.0.1:6006\n";
    const result = parseLsofListenerOutput(out);
    expect(result.get(3000)).toEqual([1234]);
    expect(result.get(6006)).toEqual([5678]);
  });
});

describe("createPortOwnershipService.findOwnedListenerInRange", () => {
  it("returns the first owned listener inside the scan range", async () => {
    const deps = createTestDeps({
      listAllListeningPorts: vi.fn().mockResolvedValue(
        new Map<number, number[]>([
          [2999, [9999]],
          [3007, [5001]],
          [3008, [5002]],
        ]),
      ),
      getProcessCwd: vi.fn().mockImplementation(async (pid: number) => {
        if (pid === 9999) return "/elsewhere";
        if (pid === 5001) return "/wt/app";
        return null;
      }),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.findOwnedListenerInRange({
      basePort: 3000,
      rangeSize: 100,
      worktreePath: "/wt",
    });

    expect(result).toEqual({
      status: "owned",
      port: 3007,
      pid: 5001,
      cwd: "/wt/app",
    });
    // Batched lookup must be a single call, not 100.
    expect(deps.listAllListeningPorts).toHaveBeenCalledTimes(1);
    expect(deps.listListeningPids).not.toHaveBeenCalled();
  });

  it("returns none when no listener in the range is owned by the worktree", async () => {
    const deps = createTestDeps({
      listAllListeningPorts: vi
        .fn()
        .mockResolvedValue(new Map<number, number[]>([[3007, [9999]]])),
      getProcessCwd: vi.fn().mockResolvedValue("/somewhere/else"),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.findOwnedListenerInRange({
      basePort: 3000,
      rangeSize: 100,
      worktreePath: "/wt",
    });

    expect(result).toEqual({ status: "none" });
  });

  it("ignores listeners outside the requested scan range", async () => {
    const deps = createTestDeps({
      listAllListeningPorts: vi
        .fn()
        .mockResolvedValue(new Map<number, number[]>([[4500, [5001]]])),
      getProcessCwd: vi.fn().mockResolvedValue("/wt/app"),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.findOwnedListenerInRange({
      basePort: 3000,
      rangeSize: 100,
      worktreePath: "/wt",
    });

    expect(result).toEqual({ status: "none" });
    expect(deps.getProcessCwd).not.toHaveBeenCalled();
  });

  it("returns none when the batched listener lookup throws", async () => {
    const deps = createTestDeps({
      listAllListeningPorts: vi.fn().mockRejectedValue(new Error("ss broke")),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.findOwnedListenerInRange({
      basePort: 3000,
      rangeSize: 100,
      worktreePath: "/wt",
    });

    expect(result).toEqual({ status: "none" });
  });
});
