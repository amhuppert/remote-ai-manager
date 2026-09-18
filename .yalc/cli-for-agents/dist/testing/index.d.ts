import type { ContractFixtures } from "./contracts.js";
export { createContractFixtures } from "./fixtures.js";
export { expectDisclosureParity } from "./contracts.js";
export type { ContractCaseName, ContractEvidence, ContractFixtures, JsonTestRun, DisclosureException, DisclosureParity } from "./contracts.js";
import type { Command, CommandSpec, Invocation } from "../commands.js";
import type { ArtifactManifest } from "../disclosure.js";
import type { Brand } from "../internal/brand.js";
import type { GuidanceEvent } from "../guidance/index.js";
import type { AnyEnvelope } from "../results.js";
import type { Cli, Environment, Host, RunResult } from "../runtime/index.js";
import type { Bytes, Milliseconds } from "../values.js";
/** Runner-neutral tests: applications keep their real domain services when useful. */
export type ContractCase = {
    readonly name: string;
    readonly run: () => Promise<void>;
};
export type HostCall = {
    readonly kind: "read" | "write" | "canonicalPath" | "kind";
    readonly path: string;
} | {
    readonly kind: "stdin" | "sha256" | "clock";
} | {
    readonly kind: "sleep";
    readonly duration: Milliseconds;
};
export type TestHost = Host & Brand<"TestHost"> & {
    readonly calls: readonly HostCall[];
    readonly filesSnapshot: () => Readonly<Record<string, Uint8Array>>;
    readonly advance: (duration: Milliseconds) => void;
};
export declare function createTestHost(options?: {
    readonly files?: Readonly<Record<string, string | Uint8Array>>;
    readonly stdin?: string;
    readonly now?: number;
}): TestHost;
export type TestEvent = GuidanceEvent | {
    readonly type: "handler.load" | "context.acquire" | "context.release";
    readonly commandPath: string;
} | {
    readonly type: "guidance.arbitrate";
};
/** Raw output plus decoded evidence; JSON envelopes exist only in JSON runs. */
export type TestRunResult = RunResult & {
    readonly artifacts: readonly ArtifactManifest[];
    readonly calls: readonly HostCall[];
    readonly events: readonly TestEvent[];
} & ({
    readonly format: "json";
    readonly envelope: AnyEnvelope;
} | {
    readonly format: "text";
    readonly envelope?: never;
});
export type TestRunOptions<Contexts> = {
    /** Omit to keep real providers/services. Overrides are invocation-local. */
    readonly contexts?: NoInfer<Contexts>;
    /** Accept real or in-memory capabilities; runForTest captures calls per invocation. */
    readonly host: Host;
    readonly env?: Environment;
    readonly format: "text" | "json";
};
export declare function runForTest<Contexts>(cli: Cli<Contexts>, input: readonly string[] | Invocation, options: TestRunOptions<Contexts>): Promise<TestRunResult>;
/** Runner-neutral checks; supply all scenarios to test a consumer's own paths. */
export declare function contractTests<Contexts>(cli: Cli<Contexts>, fixtures?: ContractFixtures): readonly ContractCase[];
export declare function expectBounded(result: RunResult, budget: Bytes): void;
/** Checks help/version/catalog/parse refusals through the registered CLI. Pass cli
 * explicitly when the same command belongs to several registries. Declaration
 * import graphs are checked separately by distribution guards. */
export declare function expectLazy<Contexts>(command: Command<CommandSpec, Contexts>, cli?: Cli<Contexts>): Promise<void>;
//# sourceMappingURL=index.d.ts.map