import { schema, type Tool } from "./types.ts";

export const timeTools: Tool[] = [
  {
    name: "get_current_time",
    description:
      "Get the current date and time. Use for anything about today, now, or the current date.",
    parameters: schema({
      timeZone: {
        type: "string",
        description: 'IANA time zone, e.g. "America/New_York". Defaults to the server zone.',
      },
    }),
    run(args) {
      const timeZone = typeof args.timeZone === "string" ? args.timeZone : undefined;
      try {
        return new Date().toLocaleString("en-US", {
          timeZone,
          dateStyle: "full",
          timeStyle: "long",
        });
      } catch {
        return `Unknown time zone: ${String(args.timeZone)}`;
      }
    },
  },
];
