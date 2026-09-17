import type { Cli, HelpNode } from "../runtime/index.js";
export declare function projectHelp<Contexts>(cli: Cli<Contexts>, path: string): HelpNode;
/** One text projection serves offline runtime help and generated references. */
export declare function renderHelp<Contexts>(cli: Cli<Contexts>, path: string): string;
/** Catalog inventory shared by offline exit-codes and reference output. */
export declare function exitCodeInventory<Contexts>(cli: Cli<Contexts>): {
    exits: readonly [{
        readonly code: 0;
        readonly exitClass: "success";
        readonly description: "The command completed successfully.";
    }, {
        readonly code: 1;
        readonly exitClass: "failed";
        readonly description: "The operation failed.";
    }, {
        readonly code: 2;
        readonly exitClass: "usage";
        readonly description: "Correct local arguments or input before retrying.";
    }, {
        readonly code: 3;
        readonly exitClass: "connection";
        readonly description: "Diagnose connection or context acquisition with the registered doctor.";
    }, {
        readonly code: 4;
        readonly exitClass: "version";
        readonly description: "Resolve version incompatibility before retrying.";
    }];
    errors: {
        [k: string]: {
            exitCode: import("../results.js").ExitCode;
            exitClass: "usage";
            description: "The invocation does not match the declared CLI contract.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "failed";
            description: "An application or protocol value violated its declared contract.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "usage";
            description: "Local file, JSON or schema input could not be validated.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "failed";
            description: "The operation was cancelled.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "failed";
            description: "The handler did not return an acknowledged outcome.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "connection";
            description: "The required application context could not be acquired.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "failed";
            description: "Required guidance conflicted or could not be collected.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "failed";
            description: "The bounded response could not be rendered or delivered.";
        } | {
            exitCode: import("../results.js").ExitCode;
            exitClass: "failed";
            description: "The application context could not be released.";
        };
    };
};
export declare function renderExitCodes<Contexts>(cli: Cli<Contexts>): string;
export declare function renderCommandReference<Contexts>(cli: Cli<Contexts>): string;
/** Runtime-composition calls this only for resolve()'s offline branch. */
export declare function renderOffline<Contexts>(cli: Cli<Contexts>, route: Extract<import("./registry.js").Resolution, {
    readonly kind: "offline";
}>, request: Pick<import("../runtime/index.js").RunRequest, "env" | "signal" | "host">): Promise<{
    readonly stdout: string;
    readonly stderr: "";
    readonly exitCode: 0;
    readonly data: import("../values.js").JsonValue;
}>;
//# sourceMappingURL=help.d.ts.map