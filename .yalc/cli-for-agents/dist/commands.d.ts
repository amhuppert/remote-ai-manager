import type { ExactInputs, ExampleInputs, InputSpec, Inputs, PayloadDeclaration, MutationPayloadDeclaration, StandardSchema, SuggestionInputs, ValidInput, Flag, ParsedFlags, ValidFlags, DerivedFileNames } from "./input.js";
import type { Brand } from "./internal/brand.js";
import type { AnyCommitReport, AnyResult, Effect, Preparation, Prepared, ErrorDefinitions, ErrorCatalog, FamilyCode, Result, CommitReport } from "./results.js";
import type { Host, Environment, InputFileSource } from "./runtime/index.js";
import type { JsonData, NonEmpty } from "./values.js";
export type SkillReference = {
    readonly path: string;
    readonly readWhen: string;
};
export type HelpSection = {
    readonly kind: "paragraphs";
    readonly title: string;
    readonly paragraphs: NonEmpty<string>;
} | {
    readonly kind: "list";
    readonly title: string;
    readonly items: NonEmpty<string>;
};
export type RelatedCommand = {
    readonly path: string;
    readonly description: string;
};
type Metadata = {
    /** Space-separated literal tokens; registration validates spelling and parent groups. */
    readonly path: string;
    readonly summary: string;
    readonly description: string;
    readonly related?: readonly RelatedCommand[];
    readonly skills?: readonly SkillReference[];
    /** Static domain facts that help interpret this command; live state belongs in HelpContext. */
    readonly sections?: readonly HelpSection[];
    /** Opt in explicitly; static help is otherwise byte-identical and context-free. */
    readonly dynamicHelp?: true;
};
export type DisclosureLevel = {
    /** Omission derives a single selector from the level key. */
    readonly selectors?: NonEmpty<string>;
    readonly output: "bounded" | "artifact-eligible";
};
export type CommandSpec = Metadata & InputSpec & {
    readonly requires: string;
    readonly output?: "binary";
} & ({
    readonly effects: "read";
    readonly levels?: Readonly<Record<string, DisclosureLevel>>;
    readonly payload?: PayloadDeclaration & {
        readonly validatePath?: never;
    };
} | {
    readonly effects: "write";
    readonly payload?: MutationPayloadDeclaration;
    readonly levels?: never;
});
type PayloadInput<S extends CommandSpec> = S extends {
    readonly payload: PayloadDeclaration;
} ? {
    readonly file: string;
} : {
    readonly file?: never;
};
/** Dispatch owns these selectors; a level's runner need not parse its own selector flag. */
type LevelInput<S extends CommandSpec> = ({
    readonly level?: never;
} & (S extends {
    readonly output: "binary";
} ? {
    readonly out?: string;
} : {
    readonly out?: never;
})) | (S extends {
    readonly levels: infer L extends Readonly<Record<string, DisclosureLevel>>;
} ? {
    [K in keyof L]: {
        readonly level: K;
    } & (L[K]["output"] extends "artifact-eligible" ? {
        readonly out?: string;
    } : {
        readonly out?: never;
    });
}[keyof L] : never);
export type CommandExample<S extends CommandSpec, G extends Readonly<Record<string, Flag>> = {}> = ExampleInputs<S & {
    readonly flags: G;
}> & PayloadInput<S> & LevelInput<S> & {
    readonly why: string;
};
/** Full input/context type for a lazy handler; there is no stdout or exit handle. */
export type HandlerContext<S extends CommandSpec, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = Inputs<S> & {
    readonly command: Command<S, never, FamilyCode<D>, G>;
    readonly errors: ErrorCatalog<D>;
    readonly globals: ParsedFlags<G>;
    readonly inputFiles: readonly InputFileSource[];
    readonly env: Environment;
    readonly host: Host;
    readonly clock: Pick<Host, "now" | "sleep">;
    readonly signal: AbortSignal;
};
export type HandlerInput<S extends CommandSpec, App, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = {
    readonly ctx: HandlerContext<S, D, G>;
} & (S["requires"] extends "none" ? {} : {
    readonly app: App;
});
/** Bounded read levels are exhaustive: adding a level requires adding its runner. */
export type ReadHandler<S extends CommandSpec, App, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = {
    readonly run: (input: HandlerInput<S, App, D, G>) => Promise<AnyResult<FamilyCode<D>>>;
    readonly prepare?: never;
    readonly commit?: never;
    readonly decode?: never;
    readonly text?: never;
} & (S extends {
    readonly levels: infer L;
} ? {
    readonly levels: {
        readonly [K in keyof L]: (input: HandlerInput<S, App, D, G>) => Promise<AnyResult<FamilyCode<D>>>;
    };
} : {
    readonly levels?: never;
});
/** A renderer is retained privately by its checked runner; only JSON data reaches it.
 * Runtime validates results before calling text, and owns the structural default.
 */
export declare function runner<Input, Data, Code extends string = string>(_definition: {
    readonly run: (input: Input) => Promise<Result<Data, Code>>;
    readonly text?: (data: NoInfer<JsonData<Data>>) => string;
}): ((input: Input) => Promise<AnyResult<Code>>) & Brand<"RenderedRunner">;
export declare function writeRunner<Input, Data, Code extends string = string>(_definition: {
    readonly run: (input: Input) => Promise<CommitReport<Data, Code>>;
    readonly text?: (data: NoInfer<JsonData<Data>>) => string;
}): ((input: Input) => Promise<AnyCommitReport<Code>>) & Brand<"RenderedWriteRunner">;
/** Scalar writes report their effect directly; no payload preparation or twin exists. */
export type WriteHandler<S extends CommandSpec, App, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = {
    readonly run: (input: HandlerInput<S, App, D, G>) => Promise<AnyCommitReport<FamilyCode<D>>>;
    readonly decode?: never;
    readonly prepare?: never;
    readonly commit?: never;
    readonly levels?: never;
    readonly text?: never;
};
export type PayloadHandlerInput<S extends CommandSpec, App, P, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = HandlerInput<S, App, D, G> & {
    readonly payload: P;
};
/** Schema and runners live together in the lazy module; execution decodes before acquiring app. */
export type PayloadReadHandler<S extends CommandSpec, App, P, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = {
    readonly decode: StandardSchema<P>;
    readonly run: (input: PayloadHandlerInput<S, App, P, D, G>) => Promise<AnyResult<FamilyCode<D>>>;
    readonly prepare?: never;
    readonly commit?: never;
    readonly text?: never;
} & (S extends {
    readonly levels: infer L;
} ? {
    readonly levels: {
        readonly [K in keyof L]: (input: PayloadHandlerInput<S, App, P, D, G>) => Promise<AnyResult<FamilyCode<D>>>;
    };
} : {
    readonly levels?: never;
});
export type PayloadReadModule<S extends CommandSpec, App, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = Brand<"PayloadReadModule", {
    readonly path: S["path"];
    readonly codes: FamilyCode<D>;
    readonly input: (input: HandlerInput<S, App, D, G>) => void;
}>;
export declare function payloadRead<S extends CommandSpec & {
    readonly effects: "read";
    readonly payload: PayloadDeclaration;
}, App, P, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}>(_handler: PayloadReadHandler<S, App, P, D, G>): PayloadReadModule<S, App, D, G>;
/** prepare and commit share one lazy decoder; the generated twin calls prepare only. */
export type MutationHandler<S extends CommandSpec, App, PreparationData, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}, P = unknown> = {
    readonly decode: StandardSchema<P>;
    readonly prepare: (input: PayloadHandlerInput<S, App, P, D, G>) => Promise<Preparation<PreparationData, FamilyCode<D>>>;
    readonly commit: (input: PayloadHandlerInput<S, App, P, D, G> & {
        readonly prepared: Prepared<S["path"], PreparationData>;
    }) => Promise<AnyCommitReport<FamilyCode<D>>>;
    readonly run?: never;
    readonly levels?: never;
    readonly text?: never;
};
/** Erases payload/preparation data only after the checked lazy module boundary. */
export type MutationModule<S extends CommandSpec, App, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = Brand<"MutationModule", {
    readonly path: S["path"];
    readonly codes: FamilyCode<D>;
    readonly input: (input: HandlerInput<S, App, D, G>) => void;
}>;
export declare function mutation<S extends CommandSpec & {
    readonly effects: "write";
    readonly payload: MutationPayloadDeclaration;
}, App, Data, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}, P = unknown>(_handler: MutationHandler<S, App, Data, D, G, P>): MutationModule<S, App, D, G>;
export type HandlerModule<S extends CommandSpec, App, D extends ErrorDefinitions = ErrorDefinitions, G extends Readonly<Record<string, Flag>> = {}> = {
    readonly default: S extends {
        readonly payload: PayloadDeclaration;
    } ? S["effects"] extends "read" ? PayloadReadModule<S, App, D, G> : MutationModule<S, App, D, G> : S["effects"] extends "read" ? ReadHandler<S, App, D, G> : WriteHandler<S, App, D, G>;
};
type SelectorNames<S extends CommandSpec> = S extends {
    readonly levels: infer L;
} ? {
    [K in keyof L & string]: L[K] extends {
        readonly selectors: readonly (infer T extends string)[];
    } ? T : K;
}[keyof L & string] : never;
type WideSelectors<L> = {
    [K in keyof L]: L[K] extends {
        readonly selectors: infer T extends readonly string[];
    } ? number extends T["length"] ? true : false : false;
}[keyof L];
type ValidLevels<S extends CommandSpec> = S extends {
    readonly levels: infer L;
} ? true extends WideSelectors<L> ? never : string extends keyof L ? never : string extends SelectorNames<S> ? never : Extract<SelectorNames<S>, import("./input.js").ReservedFlag> extends never ? unknown : never : unknown;
type IsUnion<T, Whole = T> = T extends Whole ? [Whole] extends [T] ? false : true : never;
/** A single selected key keeps none/app absence correlated across every lazy runner. */
type SingleContextKey<K extends string> = [K] extends [never] ? never : string extends K ? never : true extends IsUnion<K> ? never : unknown;
type ValidSpec<S extends CommandSpec, G extends Readonly<Record<string, Flag>>> = S & SingleContextKey<S["requires"]> & ValidInput<S, SelectorNames<S> | (keyof G & string) | DerivedFileNames<G>> & (Extract<SelectorNames<S>, keyof G | DerivedFileNames<G>> extends never ? unknown : never) & ValidLevels<S> & (string extends S["path"] ? never : unknown);
/** Declaration tokens carry checked family requirements without importing a handler. */
export type Command<S extends CommandSpec = CommandSpec, Contexts = never, Code extends string = string, G extends Readonly<Record<string, Flag>> = {}> = {
    readonly spec: S;
    readonly globalFlags: G;
} & Brand<"Command", {
    readonly contexts: (contexts: Contexts) => void;
    readonly codes: Code;
}>;
type SelectedApp<C, S extends CommandSpec> = S["requires"] extends keyof C ? C[S["requires"]] : never;
export interface CommandBuilder<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>> {
    /** Binding is separate to avoid circular inference from a lazy handler import. */
    <const S extends CommandSpec & {
        readonly requires: (keyof Contexts & string) | "none";
    }, const E extends NonEmpty<object>>(spec: ValidSpec<S, G>, binding: {
        readonly examples: E & NoInfer<NonEmpty<CommandExample<S, G>>> & {
            readonly [K in keyof E]: ExactInputs<NoInfer<E[K]>, CommandExample<NoInfer<S>, G>>;
        };
        readonly handler: () => Promise<HandlerModule<NoInfer<S>, SelectedApp<Contexts, NoInfer<S>>, D, G>>;
    }): Command<S, Contexts, FamilyCode<D>, G>;
}
export type CommandFamily<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>> = {
    readonly errors: ErrorCatalog<D>;
    readonly globalFlags: G;
    readonly defineCommand: CommandBuilder<Contexts, D, G>;
} & Brand<"CommandFamily", (contexts: Contexts) => Contexts>;
/** Bind context keys, domain errors and globals exactly once. The none key is reserved. */
export declare function commandsFor<Contexts extends object>(): <const D extends ErrorDefinitions, const G extends Readonly<Record<string, Flag>>>(options: {
    readonly errors: ErrorCatalog<D>;
    readonly globalFlags: G & ValidFlags<G>;
} & (string extends keyof Contexts ? never : "none" extends keyof Contexts ? never : unknown) & (string extends keyof D ? never : unknown)) => CommandFamily<Contexts, D, G>;
export type Group = Metadata & Brand<"Group"> & {
    readonly kind: "group";
};
export declare function defineGroup(definition: Metadata): Group;
/** Candidate command reference; registration/delivery verifies membership in this CLI. */
export type Invocation<E extends Effect = Effect, Path extends string = string> = Brand<"Invocation"> & {
    readonly path: Path;
    readonly effects: E;
    /** Canonical serializable tokens, including generated file/level options; no secrets. */
    readonly args: readonly string[];
    readonly flags: Readonly<Record<string, string | number | boolean | readonly (string | number)[]>>;
    readonly passthrough?: readonly string[];
};
type Suggestible<S extends CommandSpec, G extends Readonly<Record<string, Flag>>> = SuggestionInputs<S & {
    readonly flags: G;
}> & PayloadInput<S> & LevelInput<S>;
/** Suggestions use a real declaration token and cannot include secret or undeclared flags. */
export declare function invocation<S extends CommandSpec, G extends Readonly<Record<string, Flag>>, const I extends object>(_command: Command<S, never, string, G>, _input: I & NoInfer<Suggestible<S, G>> & ExactInputs<NoInfer<I>, NoInfer<Suggestible<S, G>>>): Invocation<S["effects"], S["path"]>;
/** The derived validation route accepts the same file and options but cannot commit. */
export declare function validationInvocation<S extends CommandSpec & {
    readonly effects: "write";
    readonly payload: MutationPayloadDeclaration;
}, G extends Readonly<Record<string, Flag>>, const I extends object>(_command: Command<S, never, string, G>, _input: I & NoInfer<Suggestible<S, G>> & ExactInputs<NoInfer<I>, NoInfer<Suggestible<S, G>>>): Invocation<"read", S["payload"]["validatePath"]>;
/** Named guidance graph; execution state remains application-owned. */
export type Flow = Brand<"Flow"> & {
    readonly id: string;
};
export declare function defineFlow(_definition: {
    readonly id: string;
    readonly steps: NonEmpty<{
        readonly command: Command;
        readonly description: string;
    }>;
}): Flow;
export {};
//# sourceMappingURL=commands.d.ts.map