import { main } from "cli-for-agents/runtime";
import { createCommandCenterCli } from "./framework/application";

await main(createCommandCenterCli());
