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

const GENERIC_MIME = new Set(["", "application/octet-stream", "binary/octet-stream"]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  heic: "image/heic",
  heif: "image/heif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};

/** The image type the first bytes say this is, or undefined. Covers what the menu reader opens. */
export function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length < 12) return undefined;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (["heic", "heix", "hevc", "heim", "heis", "hevm", "hevs"].includes(brand)) return "image/heic";
    if (["mif1", "msf1"].includes(brand)) return "image/heif";
  }
  return undefined;
}

/**
 * The image type of an attachment, or undefined when it isn't a photo.
 * Not every transport labels photos: the terminal sends a HEIC as
 * application/octet-stream, and iMessage can too. So a generic type falls
 * back to the file extension, then to the file's first bytes.
 */
export function imageType(mimeType: string | undefined, name: string | undefined, bytes?: Buffer): string | undefined {
  const mime = (mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("image/")) return mime;
  if (!GENERIC_MIME.has(mime)) return undefined;
  const extension = (name ?? "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return IMAGE_EXTENSIONS[extension] ?? (bytes ? sniffImage(bytes) : undefined);
}

const isGeneric = (mimeType: string | undefined) => GENERIC_MIME.has((mimeType ?? "").split(";")[0]!.trim().toLowerCase());

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
    // Anything labelled as an image, plus unlabelled files, which are checked below.
    if (content.type === "attachment" && (imageType(content.mimeType, content.name) || isGeneric(content.mimeType))) {
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
      const mimeType = imageType(content.mimeType, content.name, bytes);
      if (!mimeType) {
        result.unsupported = true;
        continue;
      }
      result.photos.push({
        name: content.name,
        mime_type: mimeType,
        data_base64: bytes.toString("base64"),
      });
      continue;
    }
    result.unsupported = true;
  }

  result.text = texts.join("\n").trim();
  return result;
}
