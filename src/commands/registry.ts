/**
 * CONTRACT (interface) owned by orchestrator; implementation owned by agy2 (tools).
 *
 * A command is a reusable task recipe = one markdown file `<name>.md`:
 *   ---
 *   name: review
 *   description: Review uncommitted changes and report bugs
 *   args: [focus]            # optional named arguments
 *   ---
 *   Prompt template. Use {{focus}} and {{args}} placeholders.
 *
 * Commands are exposed two ways:
 *   - as MCP prompts (clients with slash-command UIs)
 *   - via tools `commands_list` / `command_run` (returns the expanded instructions
 *     the model must now follow — works in ChatGPT and Gemini web, which do not
 *     surface MCP prompts).
 * Sources: USER_COMMANDS_DIR (writable) then BUILTIN_COMMANDS_DIR.
 */
export interface CommandSummary {
  name: string;
  description: string;
  args: string[];
  source: "user" | "builtin";
  editable: boolean;
}

export interface Command extends CommandSummary {
  template: string;
}

export interface CommandRegistry {
  list(): Promise<CommandSummary[]>;
  get(name: string): Promise<Command | undefined>;
  /** Expand template with args; unknown placeholders become "". `{{args}}` = all args joined. */
  render(name: string, args: Record<string, string>): Promise<string>;
  save(input: { name: string; description: string; args?: string[]; template: string }): Promise<CommandSummary>;
  remove(name: string): Promise<void>;
}
