import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { createBundleTransfers } from "./bundle-transfer";
import { bundleFixture } from "./bundle.fixtures";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("returns before capture finishes and binds omission acknowledgment to the immutable prepared archive", async () => {
  root = await mkdtemp(path.resolve(".cc/temp/bundle-transfer-test-"));
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const bundle = bundleFixture();
  bundle.omissions.push({
    source: "deleted-conversation",
    reason: "missing transcript",
  });
  const transfers = createBundleTransfers({
    root,
    async capture() {
      await hold;
      return bundle;
    },
    async importBundle() {
      return 3;
    },
    publish() {},
  });
  const preparing = await transfers.prepare("/old/repo", { number: 7 });
  expect(preparing.status).toBe("preparing");
  finish();
  let report = await transfers.get("/old/repo", preparing.id);
  for (let n = 0; n < 200 && report.status === "preparing"; n++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    report = await transfers.get("/old/repo", preparing.id);
  }
  expect(report.status).toBe("ready");
  await expect(transfers.download("/old/repo", report.id)).rejects.toThrow(
    /acknowledge/i,
  );
  await expect(
    transfers.download("/old/repo", report.id, "stale-digest"),
  ).rejects.toThrow(/acknowledge/i);
  expect(
    (await transfers.download("/old/repo", report.id, report.digest ?? ""))
      .byteLength,
  ).toBeGreaterThan(0);
  await expect(transfers.get("/other/repo", report.id)).rejects.toThrow(
    /not found/i,
  );
});
