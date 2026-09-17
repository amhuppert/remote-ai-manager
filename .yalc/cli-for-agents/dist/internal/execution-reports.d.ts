import type { AnyResult, ErrorCatalog, ErrorDefinitions, OperationEffect } from "../results.js";
export declare function checkedResult(value: unknown, errors: ErrorCatalog<ErrorDefinitions>, binary: boolean): AnyResult;
/** Observe independently of result validation so malformed post-write data cannot erase facts. */
export declare function observeWrite(value: Readonly<Record<string, unknown>>, fallback: OperationEffect): OperationEffect;
export declare function checkedWrite(value: Readonly<Record<string, unknown>>, operation: OperationEffect, errors: ErrorCatalog<ErrorDefinitions>, binary: boolean): AnyResult;
/** Preparation values may be opaque app objects; refusals use normal checked error/guidance fields. */
export declare function checkedPreparation(value: unknown, errors: ErrorCatalog<ErrorDefinitions>): import("../results.js").Preparation<unknown>;
//# sourceMappingURL=execution-reports.d.ts.map