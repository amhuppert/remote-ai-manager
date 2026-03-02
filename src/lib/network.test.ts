import { describe, it, expect, vi, beforeEach } from "vitest";
import * as network from "./network";

// Mock os.networkInterfaces
const mockNetworkInterfaces = vi.fn();
vi.mock("node:os", () => ({
  default: { networkInterfaces: () => mockNetworkInterfaces() },
  networkInterfaces: () => mockNetworkInterfaces(),
}));

describe("network", () => {
  beforeEach(() => {
    network._resetForTesting();
    mockNetworkInterfaces.mockReset();
  });

  describe("getLanIp", () => {
    it("returns first non-loopback IPv4 address", () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        eth0: [
          { address: "192.168.1.100", family: "IPv4", internal: false },
          { address: "fe80::1", family: "IPv6", internal: false },
        ],
      });

      expect(network.getLanIp()).toBe("192.168.1.100");
    });

    it("skips loopback interfaces", () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
        wlan0: [{ address: "10.0.0.5", family: "IPv4", internal: false }],
      });

      expect(network.getLanIp()).toBe("10.0.0.5");
    });

    it("skips IPv6 entries", () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [
          { address: "fe80::1", family: "IPv6", internal: false },
          { address: "172.16.0.10", family: "IPv4", internal: false },
        ],
      });

      expect(network.getLanIp()).toBe("172.16.0.10");
    });

    it("returns null when no non-loopback interfaces exist", () => {
      mockNetworkInterfaces.mockReturnValue({
        lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      });

      expect(network.getLanIp()).toBeNull();
    });

    it("returns null for empty interfaces", () => {
      mockNetworkInterfaces.mockReturnValue({});

      expect(network.getLanIp()).toBeNull();
    });

    it("caches result across calls", () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "192.168.1.50", family: "IPv4", internal: false }],
      });

      network.getLanIp();
      network.getLanIp();
      expect(mockNetworkInterfaces).toHaveBeenCalledTimes(1);
    });

    it("caches unavailability (does not retry)", () => {
      mockNetworkInterfaces.mockReturnValue({});

      network.getLanIp();
      network.getLanIp();
      expect(mockNetworkInterfaces).toHaveBeenCalledTimes(1);
    });
  });

  describe("getLanUrl", () => {
    it("returns http URL with LAN IP and port", () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "192.168.1.100", family: "IPv4", internal: false }],
      });

      expect(network.getLanUrl(3000)).toBe("http://192.168.1.100:3000");
    });

    it("returns null when no LAN IP available", () => {
      mockNetworkInterfaces.mockReturnValue({});

      expect(network.getLanUrl(3000)).toBeNull();
    });
  });

  describe("_resetForTesting", () => {
    it("clears cache so subsequent calls re-resolve", () => {
      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "10.0.0.1", family: "IPv4", internal: false }],
      });

      network.getLanIp();

      mockNetworkInterfaces.mockReturnValue({
        eth0: [{ address: "10.0.0.2", family: "IPv4", internal: false }],
      });

      network._resetForTesting();
      expect(network.getLanIp()).toBe("10.0.0.2");
    });
  });
});
