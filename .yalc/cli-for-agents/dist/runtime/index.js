import { projectHelp, renderCommandReference } from "../internal/help.js";
import { checkReferences, writeReference } from "../internal/references.js";
import { runProduction } from "../internal/runtime.js";
import { retainCli } from "../internal/registry.js";
import { renderReference } from "../internal/invocations.js";
import { decodeWireEnvelope } from "../results.js";
/** Synchronous shape validation only, including reference syntax/root declaration.
 * No filesystem/context acquisition or handler/schema import. Reference tooling
 * validates existence and canonical containment asynchronously before distribution. */
export function createCli(_options) { return retainCli(_options); }
/** Lazy host factory: importing the runtime never initializes heavy Node builtins. */
export async function nodeHost() {
    const { createNodeHost } = await import("../internal/node-host.js");
    return createNodeHost();
}
/** Deterministic under an injected host; effects occur through the host/application. */
export function runCli(_cli, _request) { return runProduction(_cli, _request); }
/** Node adapter owns drain-before-exit and optional compile-cache initialization. */
export async function main(_cli, _options) {
    const { runMain } = await import("../internal/process.js");
    return runMain(_cli, _options);
}
/** These APIs are offline: they never need a context, host or lazy handler. */
export function helpNode(_cli, _path) { return projectHelp(_cli, _path); }
export function commandReference(_cli) { return renderCommandReference(_cli); }
/** Checks actual files and symlink-resolved containment within cli.documentation. */
export function validateReferences(_cli, _options) { return checkReferences(_cli, _options); }
/** Build/check entry point validates referenced documents before writing/comparing.
 * check never writes; write replaces only the caller's named generated block.
 */
export function writeCommandReference(_cli, _options) { return writeReference(_cli, _options); }
/** Strictly decode untrusted JSON before treating it as a framework response. */
export function decodeEnvelope(value) { return decodeWireEnvelope(value); }
export function renderInvocation(invocation, executable) { return renderReference(invocation, executable); }
//# sourceMappingURL=index.js.map