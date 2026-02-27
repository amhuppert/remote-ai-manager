import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as tailscale from "./tailscale";

// Mock child_process.execFile
const mockExecFile = vi.fn();
vi.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));
vi.mock("node:util", () => ({
  promisify:
    () =>
    (...args: unknown[]) =>
      mockExecFile(...args),
}));

describe("TailscaleService", () => {
  beforeEach(() => {
    tailscale._resetForTesting();
    mockExecFile.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getHostname", () => {
    it("resolves hostname from tailscale status --json", async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Self: { DNSName: "my-machine.tailnet.ts.net." },
        }),
      });

      const hostname = await tailscale.getHostname();
      expect(hostname).toBe("my-machine.tailnet.ts.net");
      expect(mockExecFile).toHaveBeenCalledWith("tailscale", [
        "status",
        "--json",
      ]);
    });

    it("strips trailing dot from FQDN", async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "host.example.com." } }),
      });

      expect(await tailscale.getHostname()).toBe("host.example.com");
    });

    it("caches hostname across calls", async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "cached.ts.net." } }),
      });

      await tailscale.getHostname();
      await tailscale.getHostname();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("returns null when tailscale is unavailable", async () => {
      mockExecFile.mockRejectedValueOnce(new Error("command not found"));

      expect(await tailscale.getHostname()).toBeNull();
    });

    it("caches unavailability (does not retry)", async () => {
      mockExecFile.mockRejectedValueOnce(new Error("command not found"));

      await tailscale.getHostname();
      const result = await tailscale.getHostname();
      expect(result).toBeNull();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("returns null when DNSName is missing", async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: {} }),
      });

      expect(await tailscale.getHostname()).toBeNull();
    });
  });

  describe("register", () => {
    it("registers port over HTTP and returns remote URL", async () => {
      // First call: getHostname
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "my-host.ts.net." } }),
      });
      // Second call: tailscale serve
      mockExecFile.mockResolvedValueOnce({ stdout: "" });

      const url = await tailscale.register(3000);
      expect(url).toBe("http://my-host.ts.net:3000");
      expect(mockExecFile).toHaveBeenCalledWith("tailscale", [
        "serve",
        "--http=3000",
        "--bg",
        "localhost:3000",
      ]);
    });

    it("returns null when tailscale is unavailable", async () => {
      mockExecFile.mockRejectedValueOnce(new Error("command not found"));

      expect(await tailscale.register(3000)).toBeNull();
    });

    it("returns null when serve command fails", async () => {
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "host.ts.net." } }),
      });
      mockExecFile.mockRejectedValueOnce(new Error("permission denied"));

      expect(await tailscale.register(3000)).toBeNull();
    });
  });

  describe("unregister", () => {
    it("unregisters port", async () => {
      mockExecFile.mockResolvedValueOnce({ stdout: "" });

      await tailscale.unregister(3000);
      expect(mockExecFile).toHaveBeenCalledWith("tailscale", [
        "serve",
        "--http=3000",
        "off",
      ]);
    });

    it("swallows errors", async () => {
      mockExecFile.mockRejectedValueOnce(new Error("not found"));

      // Should not throw
      await tailscale.unregister(3000);
    });
  });
});
