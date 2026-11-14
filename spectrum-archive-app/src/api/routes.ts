// The query/send API. Mounted on the Stage 9 server, active only when API_KEY
// is set. Every route needs X-API-Key; every value from the request reaches
// DuckDB as a bind parameter (see archive/reader.ts).
import type { IncomingMessage, ServerResponse } from "node:http";

import { archiveMode } from "../env.ts";
import { type ArchiveSource, archiveSource, listSpaces, queryMessages, thread } from "../archive/reader.ts";
import type { Direction, MessageRow } from "../archive/schema.ts";
import { knownSpace, sendAndArchive } from "../archive/send.ts";
import { archiver } from "../archive/writer.ts";
import { checkApiKey } from "./auth.ts";

const MESSAGES_DEFAULT = 50;
const MESSAGES_MAX = 500;
const THREAD_DEFAULT = 1_000;
const THREAD_MAX = 5_000;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_SEND_CHARS = 4_000;
const MAX_FILTER_CHARS = 512;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

function parseLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  if (!/^\d+$/.test(raw)) throw new HttpError(400, "limit must be a positive integer");
  const value = Number(raw);
  if (value < 1) throw new HttpError(400, "limit must be at least 1");
  return Math.min(value, max); // capped, not rejected
}

function parseDate(name: string, raw: string | null): Date | undefined {
  if (raw === null || raw === "") return undefined;
  const value = new Date(raw);
  if (raw.length > 64 || Number.isNaN(value.getTime())) {
    throw new HttpError(400, `${name} must be an ISO 8601 date or timestamp`);
  }
  return value;
}

function parseFilter(name: string, raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  if (raw.length > MAX_FILTER_CHARS) throw new HttpError(400, `${name} is too long`);
  return raw;
}

function parseDirection(raw: string | null): Direction | undefined {
  if (raw === null || raw === "") return undefined;
  if (raw !== "inbound" && raw !== "outbound") {
    throw new HttpError(400, 'direction must be "inbound" or "outbound"');
  }
  return raw;
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, `body is larger than ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new HttpError(400, "body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function requireArchive(): void {
  if (archiveMode === "off") throw new HttpError(503, "the archive is off (ARCHIVE_DIR=off)");
}

const present = (row: MessageRow) => ({
  ...row,
  provider_timestamp: row.provider_timestamp?.toISOString() ?? null,
  recorded_at: row.recorded_at.toISOString(),
});

export interface ApiOptions {
  apiKey: string | undefined;
  /** Injectable for tests; defaults to the live archive. */
  source?: ArchiveSource;
}

/** Handles anything under /api. Returns false for other paths. */
export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: ApiOptions,
): Promise<boolean> {
  const { pathname } = url;
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return false;

  const { apiKey } = options;
  const source = options.source ?? archiveSource;

  if (!apiKey) {
    json(res, 404, { error: "the API is off: set API_KEY in .env to enable it" });
    return true;
  }
  if (!checkApiKey(req.headers["x-api-key"], apiKey)) {
    json(res, 401, { error: "missing or invalid X-API-Key header" });
    return true;
  }

  try {
    const method = req.method ?? "GET";
    const segments = pathname.split("/").filter(Boolean); // ["api", ...]
    const route = segments.slice(1);

    if (route.length === 1 && route[0] === "messages") {
      if (method !== "GET") throw new HttpError(405, "use GET");
      requireArchive();
      const q = url.searchParams;
      const since = parseDate("since", q.get("since"));
      const until = parseDate("until", q.get("until"));
      if (since && until && since > until) throw new HttpError(400, "since must not be after until");
      const limit = parseLimit(q.get("limit"), MESSAGES_DEFAULT, MESSAGES_MAX);

      const rows = await queryMessages(source, {
        spaceId: parseFilter("space_id", q.get("space_id")),
        platform: parseFilter("platform", q.get("platform")),
        direction: parseDirection(q.get("direction")),
        since,
        until,
        limit,
        order: "desc",
      });
      json(res, 200, { limit, count: rows.length, messages: rows.map(present) });
      return true;
    }

    if (route.length === 1 && route[0] === "spaces") {
      if (method !== "GET") throw new HttpError(405, "use GET");
      requireArchive();
      const spaces = await listSpaces(source);
      json(res, 200, { count: spaces.length, spaces });
      return true;
    }

    if (route.length === 3 && route[0] === "spaces" && route[2] === "messages") {
      if (method !== "GET") throw new HttpError(405, "use GET");
      requireArchive();
      let spaceId: string;
      try {
        spaceId = decodeURIComponent(route[1] ?? "");
      } catch {
        throw new HttpError(400, "space id is not valid URL encoding");
      }
      if (!spaceId || spaceId.length > MAX_FILTER_CHARS) throw new HttpError(400, "bad space id");
      const limit = parseLimit(url.searchParams.get("limit"), THREAD_DEFAULT, THREAD_MAX);
      const rows = await thread(source, spaceId, limit);
      json(res, 200, { space_id: spaceId, limit, count: rows.length, messages: rows.map(present) });
      return true;
    }

    if (route.length === 1 && route[0] === "send") {
      if (method !== "POST") throw new HttpError(405, "use POST");
      const body = await readJson(req);
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new HttpError(400, 'body must be {"space_id": "...", "text": "..."}');
      }
      const { space_id: spaceId, text } = body as Record<string, unknown>;
      if (typeof spaceId !== "string" || !spaceId) throw new HttpError(400, "space_id must be a non-empty string");
      if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "text must be a non-empty string");
      if (text.length > MAX_SEND_CHARS) throw new HttpError(400, `text is longer than ${MAX_SEND_CHARS} characters`);

      const space = knownSpace(spaceId);
      if (!space) {
        throw new HttpError(
          404,
          "unknown space: the API can only send to spaces that have messaged this app since it started",
        );
      }
      const { sent, row } = await sendAndArchive(space, text, "api");
      json(res, 200, {
        ok: true,
        space_id: spaceId,
        provider_message_id: sent?.id ?? null,
        archive_id: row?.archive_id ?? null,
      });
      return true;
    }

    if (route.length === 1 && route[0] === "flush") {
      if (method !== "POST") throw new HttpError(405, "use POST");
      requireArchive();
      const result = await archiver!.flush();
      json(res, result.error ? 500 : 200, result);
      return true;
    }

    throw new HttpError(404, "no such route");
  } catch (error) {
    if (error instanceof HttpError) {
      json(res, error.status, { error: error.message });
    } else {
      console.error("[api] request failed", error);
      json(res, 500, { error: "internal error" });
    }
    return true;
  }
}
