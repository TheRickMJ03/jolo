// Minimal stand-ins shaped like spectrum-ts's Space and Message (see
// node_modules/@spectrum-ts/core/dist/app-*.d.ts). Only the members this app
// touches are implemented; the cast at the end is the honest admission.
import type { Message, Space } from "spectrum-ts";

export interface FakeSpace {
  space: Space;
  sent: string[];
}

let counter = 0;

export function fakeSpace(id: string, platform = "terminal"): FakeSpace {
  const sent: string[] = [];
  const space = {
    __platform: platform,
    id,
    async send(content: unknown) {
      const text = String(content);
      sent.push(text);
      counter += 1;
      return {
        id: `out-${counter}`,
        platform,
        direction: "outbound",
        sender: { __platform: platform, id: "agent", kind: "agent" },
        content: { type: "text", text },
        timestamp: new Date(),
      };
    },
    async responding<T>(fn: () => T | Promise<T>): Promise<T> {
      return await fn();
    },
  };
  return { space: space as unknown as Space, sent };
}

export function fakeMessage(
  space: Space,
  fields: {
    id?: string;
    direction?: "inbound" | "outbound";
    content?: Record<string, unknown>;
    senderId?: string;
    timestamp?: Date;
  } = {},
): Message {
  counter += 1;
  return {
    id: fields.id ?? `in-${counter}`,
    platform: space.__platform,
    direction: fields.direction ?? "inbound",
    content: fields.content ?? { type: "text", text: "hello" },
    sender: { __platform: space.__platform, id: fields.senderId ?? "user-1" },
    space,
    timestamp: fields.timestamp ?? new Date("2026-11-10T20:00:00.000Z"),
  } as unknown as Message;
}
