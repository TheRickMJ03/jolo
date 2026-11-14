// Turns one inbound Spectrum message into text + photos for the agent. A photo
// sent with a caption arrives as a `group` whose items are messages; a lone
// photo is an `attachment`. Voice notes and non-image files are reported as
// unsupported rather than silently dropped.
import type { Message } from "spectrum-ts";

import type { Photo } from "./types.ts";

export const MAX_PHOTOS = 5;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export interface CollectedContent {
  text: string;
  photos: Photo[];
  tooManyPhotos: boolean;
  tooLarge: boolean;
  unsupported: boolean;
}

type Content = Message["content"];

function flatten(content: Content): Content[] {
  if (content.type === "group") return content.items.flatMap((item) => flatten(item.content));
  return [content];
}

export async function collectContent(message: Message): Promise<CollectedContent> {
  const result: CollectedContent = {
    text: "",
    photos: [],
    tooManyPhotos: false,
    tooLarge: false,
    unsupported: false,
  };
  const texts: string[] = [];

  for (const content of flatten(message.content)) {
    if (content.type === "text") {
      texts.push(content.text);
      continue;
    }
    if (content.type === "attachment" && content.mimeType.toLowerCase().startsWith("image/")) {
      if (result.photos.length >= MAX_PHOTOS) {
        result.tooManyPhotos = true;
        continue;
      }
      if (content.size !== undefined && content.size > MAX_PHOTO_BYTES) {
        result.tooLarge = true;
        continue;
      }
      const bytes = await content.read();
      if (bytes.length > MAX_PHOTO_BYTES) {
        result.tooLarge = true;
        continue;
      }
      result.photos.push({
        name: content.name,
        mime_type: content.mimeType,
        data_base64: bytes.toString("base64"),
      });
      continue;
    }
    result.unsupported = true;
  }

  result.text = texts.join("\n").trim();
  return result;
}
