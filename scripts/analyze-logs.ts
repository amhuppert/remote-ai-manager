#!/usr/bin/env bun

import { runLogAnalysisCli } from "../src/lib/logging/log-analysis/cli";

const exitCode = await runLogAnalysisCli(process.argv.slice(2), process);
process.exit(exitCode);
