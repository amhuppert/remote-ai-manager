export { getConversationBackendFactory, getTaskRunner } from "./registry-core";

import "./claude/conversation-runtime";
import "./claude/task-runner";
import "./codex/conversation-runtime";
import "./codex/task-runner";
