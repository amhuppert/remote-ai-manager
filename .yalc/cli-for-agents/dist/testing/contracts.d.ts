import type { Invocation } from "../commands.js";
import type { Cli, RunResult } from "../runtime/index.js";
import type { Issue, CompactRecovery } from "../results.js";
import type { Bytes, NonEmpty } from "../values.js";
import type { ContractCase, TestRunResult } from "./index.js";
export type JsonTestRun = Extract<TestRunResult, {
    readonly format: "json";
}>;
export type ContractEvidence = {
    readonly "offline-paths": {
        readonly runs: NonEmpty<TestRunResult>;
    };
    readonly "schema-issue-survival": {
        readonly json: JsonTestRun;
        readonly text: TestRunResult;
        readonly expectedIssues: NonEmpty<Issue>;
    };
    readonly "single-guidance-arbitration": {
        readonly json: JsonTestRun;
        readonly text: TestRunResult;
    };
    readonly "unknown-totals": {
        readonly json: JsonTestRun;
        readonly continuation: Invocation<"read">;
        readonly returned: number;
    };
    readonly "shell-safe-references": {
        readonly json: JsonTestRun;
        readonly rendered: string;
        readonly executable: string;
        readonly reference: Invocation;
    };
    readonly "unicode-spill": {
        readonly inline: JsonTestRun;
        readonly spilled: JsonTestRun;
        readonly budget: Bytes;
        readonly expectedSpill: string;
        readonly artifactBytes: Uint8Array;
    };
    readonly "operation-recovery": {
        readonly json: JsonTestRun;
        readonly text: TestRunResult;
        readonly effect: "applied" | "unknown";
        readonly recovery: CompactRecovery;
        readonly instruction: string;
    };
};
export type ContractCaseName = keyof ContractEvidence;
/** Each callback owns fresh services/hosts and executes its scenario. Implement
 * all seven when adapting these checks to a consumer executable or transport. */
export type ContractFixtures = {
    readonly [K in ContractCaseName]: () => Promise<ContractEvidence[K]>;
};
/** JSON-only inventory; no exception can alter the configured output byte bound. */
export type DisclosureException = {
    readonly command: string;
    readonly extraFields: NonEmpty<string>;
    readonly rationale: string;
    readonly deleteWhen: string;
};
export type DisclosureParity = {
    readonly command: string;
    readonly textFields: readonly string[];
    readonly jsonFields: readonly string[];
    readonly text: RunResult;
    readonly json: RunResult;
};
export declare function inheritedCases<Contexts>(cli: Cli<Contexts>, fixtures: ContractFixtures): readonly ContractCase[];
export declare function expectDisclosureParity<Contexts>(cli: Cli<Contexts>, exceptions: readonly DisclosureException[], observations: readonly DisclosureParity[], options?: {
    readonly satisfiedDeletionConditions?: readonly string[];
}): void;
//# sourceMappingURL=contracts.d.ts.map