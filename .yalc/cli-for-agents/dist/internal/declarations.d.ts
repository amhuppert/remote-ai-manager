import type { Command, CommandFamily, CommandSpec, Flow, Group } from "../commands.js";
import type { ErrorCatalog, ErrorDefinitions } from "../results.js";
import type { Flag } from "../input.js";
import type { InputModel } from "./input-model.js";
type Metadata = Pick<CommandSpec, "path" | "summary" | "description" | "related" | "skills" | "sections" | "dynamicHelp">;
export type CommandData = {
    readonly family: object;
    readonly model: InputModel;
    readonly examples: readonly object[];
    readonly handler: () => Promise<unknown>;
};
export declare function commandData(command: object): CommandData;
/** Family identity is checked before erasing its compile-time catalog keys. */
export declare function commandErrors(command: object): ErrorCatalog<ErrorDefinitions>;
export declare function checkFamily(family: object): void;
export declare function checkGroup(group: object): void;
export declare function flowSteps(flow: object): readonly {
    readonly command: Command;
    readonly description: string;
}[];
export declare function checkMetadata(value: Metadata): void;
export declare function makeFamily<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>>(options: {
    readonly errors: ErrorCatalog<D>;
    readonly globalFlags: G;
}): CommandFamily<Contexts, D, G>;
export declare function makeGroup(definition: Metadata): Group;
export declare function makeFlow(definition: {
    readonly id: string;
    readonly steps: readonly {
        readonly command: Command;
        readonly description: string;
    }[];
}): Flow;
export {};
//# sourceMappingURL=declarations.d.ts.map