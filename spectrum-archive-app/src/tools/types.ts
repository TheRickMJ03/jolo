export interface ToolContext {
  spaceId: string;
  platform: string;
  senderId: string;
  historyLength: number;
  /** Send a message into the conversation the tool was called from. */
  send(text: string): Promise<void>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: Record<string, unknown>, ctx: ToolContext): string | Promise<string>;
}

/** Tools take JSON-Schema objects; this trims the boilerplate. */
export function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}
