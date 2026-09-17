import type { Command, CommandSpec } from "../commands.js";
import type { Brand } from "./brand.js";
import type { Flag } from "../input.js";
import type { Issue, ErrorDefinitions, FamilyCode } from "../results.js";
import type { CliOptions } from "../runtime/index.js";
import type { CheckedInput } from "./input-model.js";
import type { InputModel } from "./input-model.js";
/** Owns the graph, family identity, doctor, input inventories and reference shapes. */
export type Registry<Contexts = never, Code extends string = string, G extends Readonly<Record<string, Flag>> = {}> = Brand<"Registry", {
    readonly contexts: (contexts: Contexts) => void;
    readonly codes: Code;
    readonly globals: G;
}>;
/** Parsing stamps the command/input pair together; execution cannot accept unchecked argv. */
export type ParsedInvocation<Contexts = never, Code extends string = string, G extends Readonly<Record<string, Flag>> = {}> = Brand<"ParsedInvocation"> & {
    readonly command: Command<CommandSpec, Contexts, Code, G>;
    readonly input: CheckedInput;
    readonly path: string;
    readonly validation: boolean;
    readonly json: boolean;
};
export type Resolution<Contexts = never, Code extends string = string, G extends Readonly<Record<string, Flag>> = {}> = {
    readonly kind: "offline";
    readonly route: "help" | "version" | "exit-codes";
    readonly path: string;
    readonly json: boolean;
} | {
    readonly kind: "leaf";
    readonly invocation: ParsedInvocation<Contexts, Code, G>;
} | {
    readonly kind: "invalid";
    readonly issues: readonly Issue[];
    readonly json: boolean;
};
/** Synchronous graph/shape validation only, including docs root/reference syntax. */
export declare function register<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>>(options: CliOptions<Contexts, D, G>): Registry<Contexts, FamilyCode<D>, G>;
export declare function resolve<Contexts, Code extends string, G extends Readonly<Record<string, Flag>>>(registry: Registry<Contexts, Code, G>, argv: readonly string[]): Resolution<Contexts, Code, G>;
export declare function checkParsedInvocation(invocation: object): void;
/** Static projections and lazy binding lookup for help, execution and composition. */
export type RegistryNode = {
    readonly path: string;
    readonly kind: "root" | "group" | "command" | "validation";
    readonly summary: string;
    readonly description: string;
    readonly command?: object;
    readonly model?: InputModel;
    readonly group?: import("../commands.js").Group;
};
type RegistryState = {
    readonly name: string;
    readonly version: string;
    readonly nodes: Readonly<Record<string, RegistryNode>>;
    readonly tokens: ReadonlySet<object>;
};
export declare function registryState(registry: object): Omit<RegistryState, "tokens">;
export declare function checkMembership(registry: object, command: object): void;
/** Most recent registration is the default owner for the command-only lazy helper. */
export declare function commandCli<Contexts>(command: object): import("../runtime/index.js").Cli<Contexts>;
export declare function retainCli<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>>(options: CliOptions<Contexts, D, G>): import("../runtime/index.js").Cli<Contexts>;
export declare function cliRegistry<Contexts>(cli: import("../runtime/index.js").Cli<Contexts>): Registry<Contexts>;
/** Lazy guidance calls this after loading rules; registration never imports them. */
export declare function checkRuleReferences(registry: object, rules: readonly {
    readonly id: string;
    readonly appliesTo: readonly object[];
}[]): void;
/** Composition retrieves retained configuration only after checking the CLI token. */
export declare function cliConfiguration<Contexts>(cli: import("../runtime/index.js").Cli<Contexts>): CliOptions<Contexts, ErrorDefinitions, Readonly<Record<string, Flag>>>;
/** Current-CLI validation is required even when a target is registered elsewhere. */
export declare function validateInvocation(registry: object, reference: import("../commands.js").Invocation): void;
/** Detached JSON references regain provenance only through complete input validation. */
export declare function rebindInvocation(registry: object, value: unknown): import("../commands.js").Invocation;
export {};
//# sourceMappingURL=registry.d.ts.map