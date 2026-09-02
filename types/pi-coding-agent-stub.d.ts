// Minimal local stand-in for `@earendil-works/pi-coding-agent` types, used only so
// `npm run check` can type-check this extension outside of a pi installation.
// At runtime, pi provides the real package; this file is never imported by pi itself.

export interface ExtensionUIContext {
  select(title: string, options: string[], opts?: unknown): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: unknown): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  [key: string]: unknown;
}

export interface ExtensionContext {
  cwd: string;
  ui: ExtensionUIContext;
  [key: string]: unknown;
}

export interface ExtensionCommandContext extends ExtensionContext {
  [key: string]: unknown;
}

export interface AgentToolResult {
  content: Array<{ type: string; text: string }>;
  details?: unknown;
  isError?: boolean;
  terminate?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (partial: Partial<AgentToolResult>) => void,
    ctx?: ExtensionContext,
  ) => Promise<AgentToolResult>;
  [key: string]: unknown;
}

export interface CommandDefinition {
  description: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  getArgumentCompletions?: (prefix: string) => unknown;
  [key: string]: unknown;
}

export interface ExtensionAPI {
  registerTool(def: ToolDefinition): void;
  registerCommand(name: string, def: CommandDefinition): void;
  on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown): void;
  getAllTools(): ToolDefinition[];
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
  [key: string]: unknown;
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
