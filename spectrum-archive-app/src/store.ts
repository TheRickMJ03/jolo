import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { memoryEnabled, memoryFile } from "./env.ts";
import type { ChatMessage } from "./llm.ts";

export interface SpaceRecord {
  transcript: ChatMessage[];
  notes: string[];
  updatedAt: string;
}

interface MemoryFile {
  version: 1;
  spaces: Record<string, SpaceRecord>;
}

const spaces = new Map<string, SpaceRecord>();
let writable = memoryEnabled;

function emptyRecord(): SpaceRecord {
  return { transcript: [], notes: [], updatedAt: new Date().toISOString() };
}

// Loaded once at startup. A corrupt or unreadable file degrades to an empty
// memory rather than stopping the app: losing history is recoverable, a
// process that will not boot is not.
function load(): void {
  if (!memoryEnabled) return;

  let parsed: MemoryFile;
  try {
    parsed = JSON.parse(readFileSync(memoryFile, "utf8")) as MemoryFile;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      console.error(`[memory] could not read ${memoryFile}, starting empty: ${String(error)}`);
    }
    return;
  }

  for (const [id, record] of Object.entries(parsed.spaces ?? {})) {
    if (Array.isArray(record?.transcript) && Array.isArray(record?.notes)) {
      spaces.set(id, record);
    }
  }
  console.log(`[memory] loaded ${spaces.size} conversation(s) from ${memoryFile}`);
}

let pending: NodeJS.Timeout | undefined;

/** Coalesces the several writes a single turn produces into one. */
export function scheduleSave(): void {
  if (!writable || pending) return;
  pending = setTimeout(() => {
    pending = undefined;
    flush();
  }, 500);
  pending.unref();
}

export function flush(): void {
  if (!writable) return;

  const contents: MemoryFile = { version: 1, spaces: Object.fromEntries(spaces) };
  try {
    mkdirSync(dirname(memoryFile), { recursive: true });
    // Write beside the target and rename: a crash mid-write then leaves the
    // previous file intact instead of a truncated one.
    const temporary = `${memoryFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(contents, null, 2), "utf8");
    renameSync(temporary, memoryFile);
  } catch (error) {
    console.error(`[memory] could not write ${memoryFile}, continuing in memory: ${String(error)}`);
    writable = false;
  }
}

export function getRecord(spaceId: string): SpaceRecord {
  const existing = spaces.get(spaceId);
  if (existing) return existing;

  const created = emptyRecord();
  spaces.set(spaceId, created);
  return created;
}

export function touch(spaceId: string): void {
  getRecord(spaceId).updatedAt = new Date().toISOString();
  scheduleSave();
}

export function dropSpace(spaceId: string): void {
  spaces.delete(spaceId);
  scheduleSave();
}

export function dropEverything(): number {
  const count = spaces.size;
  spaces.clear();
  flush();
  return count;
}

export function summary(): { id: string; turns: number; notes: number; updatedAt: string }[] {
  return [...spaces.entries()].map(([id, record]) => ({
    id,
    turns: record.transcript.length,
    notes: record.notes.length,
    updatedAt: record.updatedAt,
  }));
}

load();

// The SIGINT/SIGTERM/beforeExit handlers that call `flush()` live in
// src/index.ts, next to the archive flush, so one shutdown path runs both and
// a failure in either cannot skip the other.
