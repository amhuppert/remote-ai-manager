import type { Cli } from "../runtime/index.js";
import type { ContractFixtures } from "./contracts.js";
/** Fresh in-memory runtime fixtures. Only offline cases target the supplied
 * consumer registry; executable pilots provide all seven callbacks to exercise
 * their own domain/transport paths. No fixture runs during module import. */
export declare function createContractFixtures<Contexts>(consumer: Cli<Contexts>): ContractFixtures;
//# sourceMappingURL=fixtures.d.ts.map