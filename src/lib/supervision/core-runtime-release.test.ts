import { describe, expect, it } from "vitest";
import { releaseIdleCoreRuntime } from "./core-runtime-release";

describe("releasing a core conversation's idle runtime for a collaboration (design C5b §5)", () => {
  function host(live: boolean) {
    const released: string[] = [];
    return {
      released,
      host: {
        isLive: () => live,
        async release(conversationId: string) {
          released.push(conversationId);
        },
      },
    };
  }
  const idle = { isBusy: () => false, holdsCustody: () => false };

  it("closes the live runtime of an idle conversation", async () => {
    const h = host(true);
    expect(
      await releaseIdleCoreRuntime({ core: idle, host: h.host }, "conv-1"),
    ).toBe("released");
    expect(h.released).toEqual(["conv-1"]);
  });

  it("finds nothing to close when no runtime is live", async () => {
    const h = host(false);
    expect(
      await releaseIdleCoreRuntime({ core: idle, host: h.host }, "conv-1"),
    ).toBe("not_hosted");
    expect(h.released).toEqual([]);
  });

  it("touches nothing while custody holds the runtime or a turn runs", async () => {
    const h = host(true);
    expect(
      await releaseIdleCoreRuntime(
        { core: { ...idle, holdsCustody: () => true }, host: h.host },
        "conv-1",
      ),
    ).toBe("busy");
    expect(
      await releaseIdleCoreRuntime(
        { core: { ...idle, isBusy: () => true }, host: h.host },
        "conv-1",
      ),
    ).toBe("busy");
    expect(h.released).toEqual([]);
  });
});
