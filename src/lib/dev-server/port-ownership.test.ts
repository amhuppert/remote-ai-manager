import { describe, it, expect, vi } from "vitest";
import {
  createPortOwnershipService,
  getExitStatus,
  isOwnedProcessCwd,
  isSameOrDescendantPath,
  listListeningPidsViaExecFile,
  listListeningPidsWithExec,
  normalizePath,
  parseLsofListenerOutput,
  parseSsListenerOutput,
  type PortOwnershipDeps,
} from "./port-ownership";

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
    probePortBindable: vi.fn().mockResolvedValue({ bindable: true }),
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
  it("returns available when no listener exists on the port and the port is bindable", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([]),
      probePortBindable: vi.fn().mockResolvedValue({ bindable: true }),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3000,
      worktreePath: "/wt",
    });

    expect(result).toEqual({ status: "available" });
    expect(deps.getProcessCwd).not.toHaveBeenCalled();
    expect(deps.probePortBindable).toHaveBeenCalledWith(3000);
  });

  it("returns conflict with null pid when listener lookup is empty but bind probe fails — the Tailscale-on-macOS case where root-owned listeners are invisible to unprivileged lsof", async () => {
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([]),
      probePortBindable: vi.fn().mockResolvedValue({
        bindable: false,
        reason: "EADDRINUSE on ::",
      }),
    });
    const service = createPortOwnershipService(deps);

    const result = await service.classifyPort({
      port: 3001,
      worktreePath: "/wt",
    });

    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.pid).toBeNull();
      expect(result.cwd).toBeNull();
      expect(result.reason).toMatch(/EADDRINUSE/);
    }
  });

  it("does NOT probe-bind when a listener is identified — the existing classification path is authoritative when lsof succeeds", async () => {
    const probe = vi.fn().mockResolvedValue({ bindable: false });
    const deps = createTestDeps({
      listListeningPids: vi.fn().mockResolvedValue([12345]),
      getProcessCwd: vi.fn().mockResolvedValue("/wt"),
      probePortBindable: probe,
    });
    const service = createPortOwnershipService(deps);

    await service.classifyPort({ port: 3000, worktreePath: "/wt" });

    expect(probe).not.toHaveBeenCalled();
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

describe("getExitStatus", () => {
  it("returns the exit code from execSync errors (status field)", () => {
    expect(getExitStatus({ status: 1 })).toBe(1);
    expect(getExitStatus({ status: 127 })).toBe(127);
  });

  it("returns the exit code from execFile/promisified errors (code field)", () => {
    expect(getExitStatus({ code: 1 })).toBe(1);
    expect(getExitStatus({ code: 127 })).toBe(127);
  });

  it("returns null for system error codes like ENOENT (non-numeric code)", () => {
    expect(getExitStatus({ code: "ENOENT" })).toBeNull();
  });

  it("returns null when neither field is present", () => {
    expect(getExitStatus({})).toBeNull();
    expect(getExitStatus(new Error("boom"))).toBeNull();
  });

  it("prefers status over code when both present (execSync semantics)", () => {
    expect(getExitStatus({ status: 1, code: "ENOENT" })).toBe(1);
  });
});

describe("listListeningPidsViaExecFile (async production path)", () => {
  type ExecFileLike = (
    cmd: string,
    args: readonly string[],
  ) => Promise<{ stdout: string; stderr: string }>;

  function makeExecFileError(code: number | string): Error {
    const e = new Error("exec failed") as Error & { code: number | string };
    e.code = code;
    return e;
  }

  it("returns [] on macOS when ss is missing and lsof exits 1 (port free)", async () => {
    // This is the production failure scenario reported by the user.
    const execFile: ExecFileLike = vi.fn(async (cmd: string) => {
      if (cmd === "ss") throw makeExecFileError("ENOENT");
      if (cmd === "lsof") throw makeExecFileError(1);
      throw new Error("unexpected cmd: " + cmd);
    });

    await expect(listListeningPidsViaExecFile(3001, execFile)).resolves.toEqual(
      [],
    );
  });

  it("throws when both ss and lsof are missing (ENOENT)", async () => {
    const execFile: ExecFileLike = vi.fn(async () => {
      throw makeExecFileError("ENOENT");
    });

    await expect(listListeningPidsViaExecFile(3001, execFile)).rejects.toThrow(
      /unusable/,
    );
  });

  it("returns PIDs parsed from lsof stdout when lsof succeeds", async () => {
    const execFile: ExecFileLike = vi.fn(async (cmd: string) => {
      if (cmd === "ss") throw makeExecFileError("ENOENT");
      if (cmd === "lsof") return { stdout: "12345\n", stderr: "" };
      throw new Error("unexpected cmd: " + cmd);
    });

    await expect(listListeningPidsViaExecFile(3001, execFile)).resolves.toEqual(
      [12345],
    );
  });

  it("prefers ss output when ss returns PIDs (Linux happy path)", async () => {
    const execFile: ExecFileLike = vi.fn(async (cmd: string) => {
      if (cmd === "ss") {
        return {
          stdout:
            'LISTEN 0 511 0.0.0.0:3001 0.0.0.0:* users:(("next",pid=4242,fd=23))\n',
          stderr: "",
        };
      }
      throw new Error("should not have fallen through to lsof");
    });

    await expect(listListeningPidsViaExecFile(3001, execFile)).resolves.toEqual(
      [4242],
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
