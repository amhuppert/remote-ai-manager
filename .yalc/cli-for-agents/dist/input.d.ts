import type { Bytes, Id, NonEmpty } from "./values.js";
/** Inert descriptions. File inputs decode bounded UTF-8 text before the handler. */
export type ValueKind = {
    readonly kind: "string";
    readonly minLength?: number;
    readonly maxLength?: number;
} | {
    readonly kind: "integer";
    readonly min?: number;
    readonly max?: number;
} | {
    readonly kind: "enum";
    readonly values: NonEmpty<string>;
} | {
    readonly kind: "pattern";
    readonly pattern: string;
    readonly description: string;
} | {
    readonly kind: "url";
} | {
    readonly kind: "file";
    readonly maxBytes: Bytes;
} | {
    readonly kind: "id";
    readonly domain: string;
};
export type Argument = {
    readonly name: string;
    readonly description: string;
    readonly value: ValueKind;
    /** Positionals are required unless explicitly false. */
    readonly required?: boolean;
    readonly default?: string | number;
    readonly variadic?: true;
};
export type Flag = {
    readonly description: string;
    readonly value: ValueKind | {
        readonly kind: "boolean";
    };
    /** Flags are optional unless explicitly true. */
    readonly required?: boolean;
    readonly default?: string | number | boolean;
    readonly repeatable?: true;
    readonly secret?: true;
    /** Only a secret string credential may declare an environment fallback. */
    readonly credential?: {
        readonly env: string;
    };
    /** A string flag derives an exclusive --name-file spelling from its own key. */
    readonly fileSource?: {
        readonly maxBytes: Bytes;
    };
};
export type InputSpec = {
    readonly args: readonly Argument[];
    readonly flags: Readonly<Record<string, Flag>>;
    /** Tokens after -- are preserved verbatim only when explicitly enabled. */
    readonly passthrough?: true;
};
type ValueOf<V, Example extends boolean = false> = V extends {
    readonly kind: "integer";
} ? number : V extends {
    readonly kind: "boolean";
} ? boolean : V extends {
    readonly kind: "enum";
    readonly values: readonly (infer E)[];
} ? E : V extends {
    readonly kind: "id";
    readonly domain: infer D extends string;
} ? Example extends true ? string : Id<D> : string;
type Present<A, Positional extends boolean, Parsed extends boolean> = A extends {
    readonly default: unknown;
} ? Parsed : Parsed extends true ? A extends {
    readonly repeatable: true;
} | {
    readonly variadic: true;
} ? true : Required<A, Positional> : Required<A, Positional>;
type Required<A, Positional extends boolean> = Positional extends true ? A extends {
    readonly required: false;
} ? false : true : A extends {
    readonly required: true;
} ? true : false;
type InputValue<A, Example extends boolean> = A extends {
    readonly value: infer V;
} ? A extends {
    readonly repeatable: true;
} | {
    readonly variadic: true;
} ? A extends {
    readonly required: false;
} ? readonly ValueOf<V, Example>[] : A extends {
    readonly variadic: true;
} | {
    readonly required: true;
} ? NonEmpty<ValueOf<V, Example>> : readonly ValueOf<V, Example>[] : ValueOf<V, Example> : never;
type Args<S extends InputSpec, Example extends boolean, Parsed extends boolean> = {
    readonly [A in S["args"][number] as Present<A, true, Parsed> extends true ? A["name"] : never]: InputValue<A, Example>;
} & {
    readonly [A in S["args"][number] as Present<A, true, Parsed> extends true ? never : A["name"]]?: InputValue<A, Example>;
};
export type ParsedFlags<F extends Readonly<Record<string, Flag>>> = {
    readonly [K in keyof F as Present<F[K], false, true> extends true ? K : never]: InputValue<F[K], false>;
} & {
    readonly [K in keyof F as Present<F[K], false, true> extends true ? never : K]?: InputValue<F[K], false>;
};
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void ? I : never;
/** Read each union member: keyof a union alone hides non-shared secret keys. */
type PossibleFlagProperty<F extends Flag, K extends keyof Flag> = F extends unknown ? K extends keyof F ? F[K] : never : never;
type RequiredWithoutFallback<F extends Flag> = F extends unknown ? true extends PossibleFlagProperty<F, "required"> ? F extends {
    readonly credential: {
        readonly env: string;
    };
} ? false : true : false : never;
/** A suggestion must be runnable and secret-free for every possible declaration. */
type SuggestionFlag<K extends string, F extends Flag, Example extends boolean> = true extends PossibleFlagProperty<F, "secret"> ? true extends RequiredWithoutFallback<F> ? {
    readonly [P in K]: never;
} : {
    readonly [P in K]?: never;
} : UnionToIntersection<F extends unknown ? {
    readonly field: FlagAlternatives<K, F, Example>;
} : never> extends {
    readonly field: infer V;
} ? V : never;
type CallerFlag<K extends string, F extends Flag, Example extends boolean, Suggestion extends boolean> = Suggestion extends true ? SuggestionFlag<K, F, Example> : FlagAlternatives<K, F, Example>;
type FlagAlternatives<K extends string, F extends Flag, Example extends boolean> = F extends {
    readonly fileSource: unknown;
} ? ({
    readonly [P in K]: InputValue<F, Example>;
} & {
    readonly [P in `${K}-file`]?: never;
}) | ({
    readonly [P in K]?: never;
} & {
    readonly [P in `${K}-file`]: string;
}) | (Present<F, false, false> extends true ? never : {
    readonly [P in K | `${K}-file`]?: never;
}) : F extends {
    readonly secret: true;
    readonly credential: {
        readonly env: string;
    };
} ? {
    readonly [P in K]?: InputValue<F, Example>;
} : Present<F, false, false> extends true ? {
    readonly [P in K]: InputValue<F, Example>;
} : {
    readonly [P in K]?: InputValue<F, Example>;
};
type CallerFlags<S extends InputSpec, Example extends boolean, Suggestion extends boolean> = [
    keyof S["flags"]
] extends [never] ? {} : UnionToIntersection<{
    [K in keyof S["flags"] & string]: {
        readonly field: CallerFlag<K, S["flags"][K], Example, Suggestion>;
    };
}[keyof S["flags"] & string]> extends {
    readonly field: infer F;
} ? F : never;
type Container<K extends string, V> = {} extends V ? {
    readonly [P in K]?: V;
} : {
    readonly [P in K]: V;
};
type CallerShape<S extends InputSpec, Example extends boolean, Suggestion extends boolean> = Container<"args", Args<S, Example, false>> & Container<"flags", CallerFlags<S, Example, Suggestion>> & (S extends {
    readonly passthrough: true;
} ? {
    readonly passthrough?: readonly string[];
} : {
    readonly passthrough?: never;
});
/** Validated IDs remain branded in programmatic invocations. */
export type CallerInputs<S extends InputSpec> = CallerShape<S, false, false>;
/** Raw parser examples author IDs as strings. */
export type ExampleInputs<S extends InputSpec> = CallerShape<S, true, false>;
export type SuggestionInputs<S extends InputSpec> = CallerShape<S, false, true>;
/** Handler input always has containers, resolved defaults and repeat arrays. */
export type ParsedInputs<S extends InputSpec> = {
    readonly args: Args<S, false, true>;
    readonly flags: ParsedFlags<S["flags"]>;
} & (S extends {
    readonly passthrough: true;
} ? {
    readonly passthrough: readonly string[];
} : {
    readonly passthrough?: never;
});
export type Inputs<S extends InputSpec> = ParsedInputs<S>;
/** Literal validation complements registry validation of values and erased declarations. */
type InvalidValue<V> = V extends {
    readonly kind: "enum";
    readonly values: infer E extends readonly string[];
} ? number extends E["length"] ? true : string extends E[number] ? true : false : V extends {
    readonly kind: "id";
    readonly domain: infer D;
} ? string extends D ? true : false : false;
type InvalidFieldShape<F> = F extends {
    readonly value: infer V;
} ? InvalidValue<V> extends true ? true : F extends {
    readonly default: infer D;
} ? F extends {
    readonly required: true;
} | {
    readonly repeatable: true;
} | {
    readonly variadic: true;
} | {
    readonly fileSource: unknown;
} | {
    readonly secret: true;
} ? true : V extends {
    readonly kind: "file";
} ? true : D extends ValueOf<V, true> ? false : true : F extends {
    readonly fileSource: unknown;
} ? F extends {
    readonly value: {
        readonly kind: "string";
    };
    readonly repeatable?: never;
    readonly secret?: never;
} ? false : true : F extends {
    readonly repeatable: true;
} | {
    readonly variadic: true;
} ? V extends {
    readonly kind: "file" | "boolean";
} ? true : false : F extends {
    readonly credential: unknown;
} ? F extends {
    readonly secret: true;
    readonly value: {
        readonly kind: "string";
    };
    readonly credential: {
        readonly env: string;
    };
} ? false : true : false : true;
type InvalidField<F> = InvalidFieldShape<F> | (F extends {
    readonly credential: unknown;
} ? F extends {
    readonly secret: true;
    readonly value: {
        readonly kind: "string";
    };
    readonly repeatable?: never;
    readonly fileSource?: never;
    readonly default?: never;
} ? false : true : false);
type ValidArguments<A extends readonly Argument[], Optional extends boolean = false, Seen extends string = never> = A extends readonly [infer H extends Argument, ...infer T extends readonly Argument[]] ? H["name"] extends Seen ? false : true extends InvalidField<H> ? false : Optional extends true ? Present<H, true, false> extends true ? false : ValidArgumentTail<H, T, Seen> : ValidArgumentTail<H, T, Seen> : true;
type ValidArgumentTail<H extends Argument, T extends readonly Argument[], Seen extends string> = H extends {
    readonly variadic: true;
} ? T extends readonly [] ? true : false : ValidArguments<T, Present<H, true, false> extends true ? false : true, Seen | H["name"]>;
export type DerivedFileNames<F extends Readonly<Record<string, Flag>>> = {
    [K in keyof F & string]: F[K] extends {
        readonly fileSource: unknown;
    } ? `${K}-file` : never;
}[keyof F & string];
export type ReservedFlag = "help" | "json" | "version" | "out" | "file";
export type ValidFlags<F extends Readonly<Record<string, Flag>>, Extra extends string = never> = string extends keyof F ? never : true extends {
    [K in keyof F]: InvalidField<F[K]>;
}[keyof F] ? never : Extract<keyof F | DerivedFileNames<F>, ReservedFlag | Extra> extends never ? Extract<keyof F, DerivedFileNames<F>> extends never ? unknown : never : never;
export type ValidInput<S extends InputSpec, Extra extends string = never> = number extends S["args"]["length"] ? never : string extends S["args"][number]["name"] ? never : ValidArguments<S["args"]> extends true ? ValidFlags<S["flags"], Extra> : never;
export type PayloadDeclaration = {
    /** The framework derives --file and its stdin support; no inline JSON flag exists. */
    readonly maxBytes: Bytes;
};
export type MutationPayloadDeclaration = PayloadDeclaration & {
    /** Explicit generated validation route, reserved for payload writes. */
    readonly validatePath: string;
};
/** Structural Standard Schema v1 boundary, compatible with Zod 3.24 and 4. */
export interface StandardSchema<Output> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) => SchemaResult<Output> | Promise<SchemaResult<Output>>;
    };
}
export type SchemaIssue = {
    readonly message: string;
    readonly path?: readonly (PropertyKey | {
        readonly key: PropertyKey;
    })[];
};
export type SchemaResult<T> = {
    readonly value: T;
    readonly issues?: never;
} | {
    readonly issues: readonly SchemaIssue[];
    readonly value?: never;
};
/** Exact nested inventories survive assignment to intermediate variables. */
type Keys<T> = T extends unknown ? keyof T : never;
type At<T, K extends PropertyKey> = T extends unknown ? K extends keyof T ? NonNullable<T[K]> : never : never;
export type ExactInputs<Actual, Expected> = Actual & Record<Exclude<keyof Actual, Keys<Expected>>, never> & {
    readonly [K in keyof Actual & ("args" | "flags")]: Actual[K] & Record<Exclude<Keys<NonNullable<Actual[K]>>, Keys<At<Expected, K>>>, never>;
};
export {};
//# sourceMappingURL=input.d.ts.map