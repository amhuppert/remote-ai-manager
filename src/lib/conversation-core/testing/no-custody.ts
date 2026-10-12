import type { RuntimeCustody } from "../custody";
import type { CustodyOpener } from "../executor";

/** The runtime side of custody for tests whose runtimes owe nothing at a turn's end: it keeps none. */
export const noCustody: Pick<
  RuntimeCustody,
  "keep" | "takeOver" | "describe" | "segment"
> = {
  keep: () => null,
  async takeOver() {},
  describe: () => null,
  segment: () => null,
};

/** The executor's side, for a turn run outside it: custody never opens. */
export const noCustodyOpener: CustodyOpener = { open: () => null };
