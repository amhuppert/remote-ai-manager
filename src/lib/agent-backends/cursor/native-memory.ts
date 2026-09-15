/** This policy is delivered as user-message instructions, not a provider control. */
export const CURSOR_NATIVE_MEMORY_INSTRUCTION = `<command-center-memory-policy>
Use Command Center's shared memory as your memory system. Use the supplied memory index and cctl memory for retrieval and capture when available. Do not read or write Cursor-native memories or use them as authority over CC memory, current instructions, or live artifacts. Apply this policy to delegated work too. Conversation history remains available for continuity.
</command-center-memory-policy>`;
