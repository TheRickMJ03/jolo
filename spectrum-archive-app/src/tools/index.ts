import { archiveTools } from "./archive.ts";
import { conversationTools } from "./conversation.ts";
import { mathTools } from "./math.ts";
import { noteTools } from "./notes.ts";
import { timeTools } from "./time.ts";
import type { Tool, ToolContext } from "./types.ts";

export type { Tool, ToolContext } from "./types.ts";

// Add a tool by writing it in one of these modules, or a new one, and listing
// it here. The description is what the model reads to decide when to call it.
// (fetch_url, get_weather and set_reminder from the guide are not ported.)
export const tools: Tool[] = [
  ...timeTools,
  ...mathTools,
  ...noteTools,
  ...conversationTools,
  ...archiveTools,
];

export const toolSchemas = tools.map((tool) => ({
  type: "function" as const,
  function: {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  },
}));

export async function runTool(
  name: string,
  rawArguments: string,
  ctx: ToolContext,
): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return `No such tool: ${name}`;

  let args: Record<string, unknown>;
  try {
    // Models sometimes emit malformed or truncated JSON. Telling the model
    // beats throwing: it can correct itself on the next step.
    args = rawArguments.trim() ? JSON.parse(rawArguments) : {};
  } catch {
    return `Could not parse the arguments as JSON: ${rawArguments.slice(0, 200)}`;
  }

  // JSON.parse("3") or ("null") is valid JSON but not an argument object.
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return `The arguments must be a JSON object, got: ${rawArguments.slice(0, 200)}`;
  }

  try {
    return await tool.run(args, ctx);
  } catch (error) {
    return `The tool failed: ${String(error)}`;
  }
}
