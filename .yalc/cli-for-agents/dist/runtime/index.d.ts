import type { Command, CommandSpec, CommandFamily, Flow, Group, Invocation, HelpSection, SkillReference, RelatedCommand } from "../commands.js";
import type { ArtifactPolicy } from "../disclosure.js";
import type { EvaluatedGuidance, ConflictSink } from "../guidance/index.js";
import type { Brand } from "../internal/brand.js";
import type { AnyEnvelope, OperationOutcome, ErrorDefinitions, FamilyCode, ExitCode } from "../results.js";
import type { Flag, ParsedFlags } from "../input.js";
import type { Bytes, Milliseconds, NonEmpty } from "../values.js";
export type Environment = Readonly<Record<string, string | undefined>>;
/** Side effects required by the kernel. Transport and logging belong to the application. */
export interface Host {
    readonly files: {
        /** Reject when the file exceeds limit; never return silently truncated input. */
        readonly read: (path: string, limit: Bytes, signal: AbortSignal) => Promise<Uint8Array>;
        /** Same overflow rule as read; cancellation aborts waiting for stdin. */
        readonly readStdin: (limit: Bytes, signal: AbortSignal) => Promise<Uint8Array>;
        /** Resolve existing symlinks, including ancestors of a not-yet-existing file.
         * Directory-only spellings reject existing non-directories; a missing
         * directory result retains a trailing separator. */
        readonly canonicalPath: (path: string) => Promise<string>;
        /** Follows canonical path checks; reference tooling distinguishes missing files. */
        readonly kind: (path: string) => Promise<"file" | "directory" | "missing">;
        /** Optional opt-in cleanup capabilities. Names are direct regular-file children;
         * remove refuses symlinks or content changed since inspection. */
        readonly retention?: {
            readonly list: (directory: string) => Promise<readonly string[]>;
            readonly remove: (path: string, expected: Uint8Array) => Promise<boolean>;
        };
        readonly writeAtomic: (path: string, data: Uint8Array, collision: "reuse-identical-or-refuse") => Promise<void>;
    };
    readonly now: () => number;
    readonly sleep: (duration: Milliseconds, signal: AbortSignal) => Promise<void>;
    /** The kernel validates the returned hex digest before minting Sha256. */
    readonly sha256: (data: Uint8Array) => Promise<string>;
}
/** Required application state is acquired only after offline routes and parsing finish. */
export type ContextProvider<App, G extends Readonly<Record<string, Flag>> = {}, Code extends string = string> = (input: {
    readonly env: Environment;
    readonly globals: ParsedFlags<G>;
    readonly host: Host;
    readonly signal: AbortSignal;
}) => Promise<{
    readonly ok: true;
    readonly app: App;
    readonly release?: () => void | Promise<void>;
    readonly error?: never;
} | {
    readonly ok: false;
    readonly error: import("../results.js").CliError<Code>;
    readonly app?: never;
    readonly release?: never;
}>;
/** Optional providers acquire their own read-only context within the total help deadline. */
export type HelpContextProvider = (input: {
    readonly path: string;
    readonly env: Environment;
    readonly signal: AbortSignal;
}) => Promise<readonly {
    readonly text: string;
}[]>;
export type HelpContext = {
    readonly load: () => Promise<readonly HelpContextProvider[]>;
    readonly deadline?: Milliseconds;
    readonly maxBytes: Bytes;
    readonly maxBlocks?: 1 | 2 | 3;
};
/** Discriminated acquired state; none has no app and no provider/finalizer. */
export type SelectedContext<Contexts> = {
    readonly requires: "none";
    readonly app?: never;
} | {
    [K in keyof Contexts & string]: {
        readonly requires: K;
        readonly app: Contexts[K];
    };
}[keyof Contexts & string];
/** Original declared file origins, never contents or secret flag paths. '-' denotes stdin.
 * A derived --body-file source uses its logical flag name 'body'. */
export type InputFileSource = {
    readonly kind: "payload" | "argument" | "flag" | "global";
    readonly name: string;
    readonly path: string;
};
export type PostOperationContext<Contexts> = SelectedContext<Contexts> & {
    readonly command: Command;
    readonly outcome: OperationOutcome;
    readonly inputFiles: readonly InputFileSource[];
    readonly env: Environment;
    readonly host: Host;
    readonly signal: AbortSignal;
};
/** Separate authority batches retain their provenance through one arbitration. */
export type GuidanceSources = EvaluatedGuidance | readonly EvaluatedGuidance[];
/** Loaded only for execution, while the selected app is still alive. */
export type GuidanceProvider<Contexts> = (input: PostOperationContext<Contexts>) => Promise<GuidanceSources>;
export type ArtifactPolicySource<Contexts> = ArtifactPolicy | {
    readonly resolve: (input: PostOperationContext<Contexts>) => ArtifactPolicy | Promise<ArtifactPolicy>;
};
/** Relative skill paths are interpreted inside this consumer-owned root. */
export type DocumentationRoot = {
    readonly directory: string;
};
export type ContextProviders<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>> = {
    readonly [K in keyof Contexts]-?: ContextProvider<Contexts[K], G, FamilyCode<D>>;
};
export type CliOptions<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>> = {
    readonly name: string;
    readonly version: string;
    readonly family: CommandFamily<Contexts, D, G>;
    readonly commands: readonly Command<CommandSpec, NoInfer<Contexts>, FamilyCode<NoInfer<D>>, NoInfer<G>>[];
    readonly groups?: readonly Group[];
    readonly flows?: readonly Flow[];
    readonly contexts: ContextProviders<NoInfer<Contexts>, NoInfer<D>, NoInfer<G>>;
    readonly errors?: never;
    readonly application?: never;
    readonly guidance?: {
        readonly load: () => Promise<{
            readonly default: GuidanceProvider<Contexts>;
        }>;
        readonly conflictSink: ConflictSink;
    };
    readonly output: {
        readonly maxBytes?: Bytes;
        readonly artifacts: ArtifactPolicySource<Contexts>;
    };
    readonly documentation?: DocumentationRoot;
    readonly helpContext?: HelpContext;
    /** Required even without domain connection codes: KERNEL_CONTEXT uses exit 3. */
    readonly doctor: Invocation<"read">;
};
export type Cli<Contexts = never> = Brand<"Cli", (contexts: Contexts) => void>;
/** Synchronous shape validation only, including reference syntax/root declaration.
 * No filesystem/context acquisition or handler/schema import. Reference tooling
 * validates existence and canonical containment asynchronously before distribution. */
export declare function createCli<Contexts, const D extends ErrorDefinitions, const G extends Readonly<Record<string, Flag>>>(_options: CliOptions<Contexts, D, G>): Cli<Contexts>;
export type RunRequest = {
    readonly argv: readonly string[];
    readonly env: Environment;
    /** Omission resolves nodeHost lazily; injected hosts avoid Node acquisition. */
    readonly host?: Host;
    readonly signal: AbortSignal;
};
export type ResolvedRunRequest = RunRequest & {
    readonly host: Host;
};
/** Lazy host factory: importing the runtime never initializes heavy Node builtins. */
export declare function nodeHost(): Promise<Host>;
/** Text is already rendered and byte-bounded across both streams. It is not handler data. */
export type RenderedText = string & Brand<"RenderedText">;
export type RunResult = Brand<"RunResult"> & {
    readonly stdout: RenderedText;
    readonly stderr: RenderedText;
    readonly exitCode: ExitCode;
};
/** Deterministic under an injected host; effects occur through the host/application. */
export declare function runCli<App>(_cli: Cli<App>, _request: RunRequest): Promise<RunResult>;
/** Node adapter owns drain-before-exit and optional compile-cache initialization. */
export declare function main<App>(_cli: Cli<App>, _options?: {
    readonly compileCache?: boolean;
}): Promise<never>;
/** Registry-derived structured documentation, including generated flags and twins. */
export type HelpFlag = {
    readonly name: string;
    readonly description: string;
    readonly kind: "boolean" | "value";
    readonly source: "domain" | "global" | "file" | "payload" | "selector" | "framework";
    readonly required: boolean;
    readonly repeatable: boolean;
    readonly value: Flag["value"] | {
        readonly kind: "output-path";
    };
    readonly fileAlternative?: {
        readonly name: string;
        readonly maxBytes: Bytes;
    };
    readonly credentialEnv?: string;
    readonly valuePlaceholder?: string;
    readonly choices?: readonly string[];
    readonly default?: string | number | boolean;
};
export type HelpArgument = {
    readonly name: string;
    readonly description: string;
    readonly required: boolean;
    readonly variadic: boolean;
    readonly value: import("../input.js").Argument["value"];
    readonly default?: string | number;
};
export type HelpNode = {
    readonly path: string;
    readonly kind: "root" | "group" | "command" | "validation";
    readonly summary: string;
    readonly description: string;
    readonly usage: readonly string[];
    readonly children: readonly {
        readonly path: string;
        readonly summary: string;
    }[];
    readonly related: readonly RelatedCommand[];
    readonly flags: readonly HelpFlag[];
    readonly arguments: readonly HelpArgument[];
    readonly examples: readonly ({
        readonly invocation: Invocation;
        readonly why: string;
        readonly template?: never;
    } | {
        readonly template: Readonly<Record<string, import("../values.js").JsonValue>>;
        readonly why: string;
        readonly invocation?: never;
    })[];
    readonly skills: readonly SkillReference[];
    readonly sections: readonly HelpSection[];
    readonly dynamicHelp: boolean;
    readonly effects?: "read" | "write";
    readonly levels?: Readonly<Record<string, {
        readonly selectors: readonly string[];
        readonly output: "bounded" | "artifact-eligible";
    }>>;
    readonly payload?: {
        readonly maxBytes: Bytes;
        readonly validatePath?: string;
    };
    readonly output?: "binary";
    readonly flows: readonly {
        readonly id: string;
        readonly steps: readonly {
            readonly path: string;
            readonly description: string;
        }[];
    }[];
};
/** These APIs are offline: they never need a context, host or lazy handler. */
export declare function helpNode<Contexts>(_cli: Cli<Contexts>, _path: string): HelpNode;
export declare function commandReference<Contexts>(_cli: Cli<Contexts>): string;
export type ReferenceIssue = {
    readonly code: "missing_documentation_root" | "missing_reference" | "outside_documentation_root" | "invalid_reference";
    readonly commandPath: string;
    readonly reference: string;
};
export type ReferenceValidation = {
    readonly ok: true;
    readonly checked: number;
    readonly issues: readonly [];
} | {
    readonly ok: false;
    readonly checked: number;
    readonly issues: NonEmpty<ReferenceIssue>;
};
export type ReferenceHost = {
    readonly files: Host["files"] & {
        /** Reference-tool-only replacement of an existing document. Refuse stale
         * expected bytes; preserve unrelated content. Absent capability permits check
         * mode only. The kernel artifact writer remains no-clobber. */
        readonly replace?: (path: string, data: Uint8Array, expected: Uint8Array, signal: AbortSignal) => Promise<void>;
    };
};
export type ReferenceOptions = {
    /** Bounds existing reference-file reads; defaults to 1 MiB. */
    readonly maxBytes?: Bytes;
    /** Injected host or lazy loader; omission resolves nodeHost only when called. */
    readonly host?: ReferenceHost | (() => Promise<ReferenceHost>);
    readonly signal: AbortSignal;
};
/** Checks actual files and symlink-resolved containment within cli.documentation. */
export declare function validateReferences<Contexts>(_cli: Cli<Contexts>, _options: ReferenceOptions): Promise<ReferenceValidation>;
/** Build/check entry point validates referenced documents before writing/comparing.
 * check never writes; write replaces only the caller's named generated block.
 */
export declare function writeCommandReference<Contexts>(_cli: Cli<Contexts>, _options: ReferenceOptions & {
    readonly path: string;
    readonly marker: string;
    readonly mode: "write" | "check";
}): Promise<ReferenceValidation & {
    readonly changed: boolean;
}>;
/** Strictly decode untrusted JSON before treating it as a framework response. */
export declare function decodeEnvelope(value: unknown): AnyEnvelope;
export declare function renderInvocation(invocation: Invocation, executable: string): import("../values.js").ShellSafe;
//# sourceMappingURL=index.d.ts.map