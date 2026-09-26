import type { Command, Invocation } from "../commands.js";
import type { Hint } from "../guidance/index.js";
import type { Flag } from "../input.js";
import type { ParsedInvocation, Registry } from "./registry.js";
/** An invocation is plain JSON. The registry resolves it by path when it is used,
 * so references survive JSON transport unchanged. Also used for createCli's doctor. */
export declare function makeInvocation(command: Pick<Command, "spec" | "globalFlags">, input: object, validation: boolean): Invocation;
/** Advisory write suggested after a successful validation twin. It replays the parsed
 * inputs, never decoded file contents or environment values, and is omitted whenever
 * stdin, a supplied secret, passthrough tokens or the reference bound prevents a
 * faithful replay. Rebinding and reparsing prove the write parses to the same inputs. */
export declare function validationWriteHint<Contexts, Code extends string, G extends Readonly<Record<string, Flag>>>(registry: Registry<Contexts, Code, G>, parsed: ParsedInvocation<Contexts, Code, G>): Hint | undefined;
/** argv construction and shell rendering share exactly these token boundaries.
 * A passthrough command always carries its passthrough tokens, possibly empty. */
export declare function invocationArgv(reference: Invocation): readonly string[];
/** Also used after detached reference shape validation at the registry boundary. */
export declare function referenceTokens(reference: Pick<Invocation, "path" | "args" | "flags" | "passthrough">, passthrough: boolean): readonly string[];
/** Shape-checked rendering; current-registry rebinding is caller-owned. */
export declare function renderReference(reference: Invocation, executable: string): import("../values.js").ShellSafe;
//# sourceMappingURL=invocations.d.ts.map