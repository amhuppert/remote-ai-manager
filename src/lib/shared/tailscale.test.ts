import { describe, it, expect, vi } from "vitest";
import { createTailscaleService } from "./tailscale";
import type { TailscaleDeps } from "./tailscale";

function createMockDeps(): {
  deps: TailscaleDeps;
  mockExecFile: ReturnType<typeof vi.fn>;
} {
  const mockExecFile = vi.fn();
  return { deps: { execFileAsync: mockExecFile }, mockExecFile };
}

describe("TailscaleService", () => {
  describe("getHostname", () => {
    it("resolves hostname from tailscale status --json", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({
          Self: { DNSName: "my-machine.tailnet.ts.net." },
        }),
      });

      const service = createTailscaleService(deps);
      const hostname = await service.getHostname();
      expect(hostname).toBe("my-machine.tailnet.ts.net");
      expect(mockExecFile).toHaveBeenCalledWith("tailscale", [
        "status",
        "--json",
      ]);
    });

    it("strips trailing dot from FQDN", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "host.example.com." } }),
      });

      const service = createTailscaleService(deps);
      expect(await service.getHostname()).toBe("host.example.com");
    });

    it("caches hostname across calls", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "cached.ts.net." } }),
      });

      const service = createTailscaleService(deps);
      await service.getHostname();
      await service.getHostname();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("returns null when tailscale is unavailable", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockRejectedValueOnce(new Error("command not found"));

      const service = createTailscaleService(deps);
      expect(await service.getHostname()).toBeNull();
    });

    it("caches unavailability (does not retry)", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockRejectedValueOnce(new Error("command not found"));

      const service = createTailscaleService(deps);
      await service.getHostname();
      const result = await service.getHostname();
      expect(result).toBeNull();
      expect(mockExecFile).toHaveBeenCalledTimes(1);
    });

    it("returns null when DNSName is missing", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: {} }),
      });

      const service = createTailscaleService(deps);
      expect(await service.getHostname()).toBeNull();
    });

    it("new instance gets fresh cache", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "old.ts.net." } }),
      });

      const service1 = createTailscaleService(deps);
      await service1.getHostname();

      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "new.ts.net." } }),
      });

      const service2 = createTailscaleService(deps);
      expect(await service2.getHostname()).toBe("new.ts.net");
    });
  });

  describe("register", () => {
    it("registers port over HTTP and returns remote URL", async () => {
      const { deps, mockExecFile } = createMockDeps();
      // First call: getHostname
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "my-host.ts.net." } }),
      });
      // Second call: tailscale serve
      mockExecFile.mockResolvedValueOnce({ stdout: "" });

      const service = createTailscaleService(deps);
      const url = await service.register(3000);
      expect(url).toBe("http://my-host.ts.net:3000");
      expect(mockExecFile).toHaveBeenCalledWith("tailscale", [
        "serve",
        "--http=3000",
        "--bg",
        "localhost:3000",
      ]);
    });

    it("returns null when tailscale is unavailable", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockRejectedValueOnce(new Error("command not found"));

      const service = createTailscaleService(deps);
      expect(await service.register(3000)).toBeNull();
    });

    it("returns null when serve command fails", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({ Self: { DNSName: "host.ts.net." } }),
      });
      mockExecFile.mockRejectedValueOnce(new Error("permission denied"));

      const service = createTailscaleService(deps);
      expect(await service.register(3000)).toBeNull();
    });
  });

  describe("unregister", () => {
    it("unregisters port", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({ stdout: "" });

      const service = createTailscaleService(deps);
      await service.unregister(3000);
      expect(mockExecFile).toHaveBeenCalledWith("tailscale", [
        "serve",
        "--http=3000",
        "off",
      ]);
    });

    it("swallows errors", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockRejectedValueOnce(new Error("not found"));

      const service = createTailscaleService(deps);
      // Should not throw
      await service.unregister(3000);
    });
  });

  describe("listServeRegistrations", () => {
    it("extracts symmetric http://localhost:N → port N entries that CC creates", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({
        stdout: JSON.stringify({
          TCP: {
            "3001": { HTTP: true },
            "6007": { HTTP: true },
            "443": { HTTPS: true },
          },
          Web: {
            "host.ts.net:3001": {
              Handlers: { "/": { Proxy: "http://localhost:3001" } },
            },
            "host.ts.net:6007": {
              Handlers: { "/": { Proxy: "http://localhost:6007" } },
            },
            "host.ts.net:443": {
              Handlers: {
                "/": { Proxy: "https+insecure://localhost:3000" },
              },
            },
          },
        }),
      });

      const service = createTailscaleService(deps);
      const entries = await service.listServeRegistrations();

      expect(entries).toEqual(
        expect.arrayContaining([
          { port: 3001, proxyTarget: "http://localhost:3001" },
          { port: 6007, proxyTarget: "http://localhost:6007" },
        ]),
      );
      // The 443 → localhost:3000 entry is asymmetric (CC's app, user-configured)
      // and must be excluded so reconciliation never touches it.
      expect(entries.find((e) => e.port === 443)).toBeUndefined();
      expect(entries.find((e) => e.port === 3000)).toBeUndefined();
    });

    it("returns [] when tailscale CLI is unavailable", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockRejectedValueOnce(new Error("command not found"));

      const service = createTailscaleService(deps);
      expect(await service.listServeRegistrations()).toEqual([]);
    });

    it("returns [] when tailscale serve status emits unparseable JSON", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({ stdout: "not-json" });

      const service = createTailscaleService(deps);
      expect(await service.listServeRegistrations()).toEqual([]);
    });

    it("returns [] when no serve entries are configured", async () => {
      const { deps, mockExecFile } = createMockDeps();
      mockExecFile.mockResolvedValueOnce({ stdout: "{}" });

      const service = createTailscaleService(deps);
      expect(await service.listServeRegistrations()).toEqual([]);
    });
  });
});
