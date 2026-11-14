import { schema, type Tool } from "./types.ts";

export const conversationTools: Tool[] = [
  {
    name: "conversation_info",
    description:
      "Facts about the current conversation: which messaging platform it is on, who is speaking, and how many turns are remembered.",
    parameters: schema({}),
    run(_args, ctx) {
      return JSON.stringify({
        platform: ctx.platform,
        spaceId: ctx.spaceId,
        senderId: ctx.senderId,
        rememberedTurns: ctx.historyLength,
      });
    },
  },
];
