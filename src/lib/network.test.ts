import { describe, it, expect, vi } from "vitest";
import { createNetworkService } from "./network";
import type { NetworkDeps } from "./network";

function mockDeps(fn: ReturnType<typeof vi.fn> = vi.fn()): {
  deps: NetworkDeps;
  mockNetworkInterfaces: ReturnType<typeof vi.fn>;
} {
  return { deps: { networkInterfaces: fn }, mockNetworkInterfaces: fn };
}

describe("network", () => {
  describe("getLanIp", () => {
    it("returns first non-loopback IPv4 address", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [
          { address: "192.168.1.100", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
      });

      const service = createNetworkService(deps);
      expect(service.getLanIp()).toBe("192.168.1.100");
    });

    it("skips loopback interfaces", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        wlan0: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
      });

      const service = createNetworkService(deps);
      expect(service.getLanIp()).toBe("10.0.0.5");
    });

    it("skips IPv6 entries", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({
        eth0: [
          { address: "fe80::1", family: "IPv6", internal: false },
          { address: "172.16.0.10", family: "IPv4", internal: false },
        ],
      });

      const service = createNetworkService(deps);
      expect(service.getLanIp()).toBe("172.16.0.10");
    });

    it("returns null when no non-loopback interfaces exist", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      });

      const service = createNetworkService(deps);
      expect(service.getLanIp()).toBeNull();
    });

    it("returns null for empty interfaces", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({});

      const service = createNetworkService(deps);
      expect(service.getLanIp()).toBeNull();
    });

    it("caches result across calls", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "192.168.1.50", family: "IPv4", internal: false }],
      });

      const service = createNetworkService(deps);
      service.getLanIp();
      service.getLanIp();
      expect(mockNetworkInterfaces).toHaveBeenCalledTimes(1);
    });

    it("caches unavailability (does not retry)", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({});

      const service = createNetworkService(deps);
      service.getLanIp();
      service.getLanIp();
      expect(mockNetworkInterfaces).toHaveBeenCalledTimes(1);
    });

    it("new instance gets fresh cache", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "10.0.0.1", family: "IPv4", internal: false }],
      });

      const service1 = createNetworkService(deps);
      service1.getLanIp();

      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "10.0.0.2", family: "IPv4", internal: false }],
      });

      const service2 = createNetworkService(deps);
      expect(service2.getLanIp()).toBe("10.0.0.2");
    });
  });

  describe("getLanUrl", () => {
    it("returns http URL with LAN IP and port", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "192.168.1.100", family: "IPv4", internal: false }],
      });

      const service = createNetworkService(deps);
      expect(service.getLanUrl(3000)).toBe("http://192.168.1.100:3000");
    });

    it("returns null when no LAN IP available", () => {
      const { deps, mockNetworkInterfaces } = mockDeps();
      mockNetworkInterfaces.mockReturnValue({});

      const service = createNetworkService(deps);
      expect(service.getLanUrl(3000)).toBeNull();
    });
  });
});
