import { getRecord, touch } from "../store.ts";
import { schema, type Tool } from "./types.ts";

const MAX_NOTES = 50;

export const noteTools: Tool[] = [
  {
    name: "save_note",
    description:
      "Save a fact worth remembering about this person or conversation, beyond the recent messages. Use when told something durable, like a preference, a name, or a plan.",
    parameters: schema(
      { note: { type: "string", description: "The fact, in one short sentence." } },
      ["note"],
    ),
    run(args, ctx) {
      const note = String(args.note ?? "").trim();
      if (!note) return "Nothing to save.";

      const record = getRecord(ctx.spaceId);
      if (record.notes.includes(note)) return "Already saved.";

      record.notes.push(note);
      // Notes outlive the transcript, so they need their own ceiling.
      record.notes = record.notes.slice(-MAX_NOTES);
      touch(ctx.spaceId);

      return `Saved. ${record.notes.length} note(s) for this conversation.`;
    },
  },
  {
    name: "list_notes",
    description: "List everything saved about this conversation.",
    parameters: schema({}),
    run(_args, ctx) {
      const { notes } = getRecord(ctx.spaceId);
      return notes.length === 0
        ? "No notes saved yet."
        : notes.map((note, i) => `${i + 1}. ${note}`).join("\n");
    },
  },
  {
    name: "forget_note",
    description: "Delete one saved note by its number, as shown by list_notes.",
    parameters: schema(
      { number: { type: "number", description: "1-based position from list_notes." } },
      ["number"],
    ),
    run(args, ctx) {
      const record = getRecord(ctx.spaceId);
      const index = Number(args.number) - 1;

      if (!Number.isInteger(index) || index < 0 || index >= record.notes.length) {
        return `There is no note ${String(args.number)}. There are ${record.notes.length}.`;
      }

      const [removed] = record.notes.splice(index, 1);
      touch(ctx.spaceId);
      return `Forgot: ${removed}`;
    },
  },
];
