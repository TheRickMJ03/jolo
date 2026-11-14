// Where messages meet the archive.
//
// - `archiveInbound` records one inbound content message.
// - `sendAndArchive` is the ONLY way this app sends text: respond(), the
//   agent's ctx.send and POST /api/send all go through it, so every outbound
//   message gets exactly one row. Provider echoes of these sends are skipped in
//   respond(), which is what keeps them from becoming duplicate rows.
// - The space registry backs POST /api/send. spectrum-ts has no generic
//   "send to space id" call that works across providers without platform
//   narrowing, and resolving arbitrary ids would let an API caller message
//   anyone, so the API can only send to spaces that have messaged us since boot.
import type { Message, Space } from "spectrum-ts";

import type { MessageRow, Source } from "./schema.ts";
import { archiver, buildRow } from "./writer.ts";

const spaces = new Map<string, Space>();

export function rememberSpace(space: Space): void {
  spaces.set(space.id, space);
}

export function knownSpace(spaceId: string): Space | undefined {
  return spaces.get(spaceId);
}

const validDate = (value: unknown): Date | null =>
  value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;

export function archiveInbound(
  space: Space,
  message: Message,
  source: "stream" | "webhook",
): MessageRow | undefined {
  if (!archiver) return undefined;
  try {
    return archiver.archive(
      buildRow({
        provider_message_id: message.id || null,
        space_id: space.id,
        platform: message.platform,
        direction: "inbound",
        sender_id: message.sender?.id ?? null,
        content_type: message.content.type,
        text: message.content.type === "text" ? message.content.text : null,
        source,
        provider_timestamp: validDate(message.timestamp),
      }),
    );
  } catch (error) {
    // archive() already never throws; this guards the row-building above.
    console.error(`[archive] could not archive inbound message: ${String(error)}`);
    return undefined;
  }
}

export interface SendResult {
  sent: Message | undefined;
  row: MessageRow | undefined;
}

export async function sendAndArchive(
  space: Space,
  text: string,
  source: Extract<Source, "agent" | "api">,
): Promise<SendResult> {
  // A failed send throws to the caller, and nothing is archived: there is
  // nothing to record.
  const sent = await space.send(text);

  let row: MessageRow | undefined;
  if (archiver) {
    try {
      row = archiver.archive(
        buildRow({
          // The SDK resolves undefined when a provider returns no handle.
          provider_message_id: sent?.id || null,
          space_id: space.id,
          platform: sent?.platform ?? space.__platform,
          direction: "outbound",
          sender_id: sent?.sender?.id ?? null,
          content_type: "text",
          text,
          source,
          provider_timestamp: validDate(sent?.timestamp),
        }),
      );
    } catch (error) {
      console.error(`[archive] could not archive outbound message: ${String(error)}`);
    }
  }
  return { sent, row };
}
