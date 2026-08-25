/**
 * The tool names every roster agent can pick from without typing one in.
 *
 * Not the full list Claude Code recognises — just the common ones, so the
 * multiselect in the editor dialog is useful without scrolling. An admin who
 * needs something else (an MCP tool, say) can still add it by name through
 * the free-text field next to this list; nothing here validates against it,
 * so an unrecognised name still round-trips through `tools` unharmed.
 */
export const KNOWN_TOOL_NAMES: readonly string[] = [
  "Read",
  "Grep",
  "Glob",
  "Bash",
  "Edit",
  "Write",
  "WebFetch",
  "WebSearch",
  "Task",
  "TodoWrite",
];
