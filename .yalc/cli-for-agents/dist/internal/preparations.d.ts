import type { Prepared } from "../results.js";
import type { Sha256 } from "../values.js";
/** Execution creates one scope per run; neither the scope nor its mint is public. */
export declare function preparationScope(command: object, hash: Sha256): object;
export declare function mintPreparation(scope: object, value: unknown): Prepared<string, unknown>;
/** Validate all provenance and consume before calling application commit, even if it throws. */
export declare function usePreparation<T>(scope: object, token: Prepared<string, unknown>, hash: Sha256, commit: (token: Prepared<string, unknown>) => Promise<T>): Promise<T>;
//# sourceMappingURL=preparations.d.ts.map