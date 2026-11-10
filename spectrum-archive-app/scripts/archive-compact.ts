// `npm run archive:compact -- YYYY-MM-DD` — merge the small files in each hour
// partition of one day into a single file.
//
// For each hour with two or more files: COPY them into one new part file,
// then count the rows in the new file. Only if that count equals the sum of
// the originals (and the schema matches) are the originals deleted; otherwise
// the new file is removed and the originals stay. Safe to run while the app is
// up: the app only ever adds new uniquely-named files, and readers dedupe on
// archive_id, so a reader that sees old and new at once still counts each row
// once.
import { randomUUID } from "node:crypto";
import { renameSync, rmSync } from "node:fs";

import { LIST, listValue, VARCHAR } from "@duckdb/node-api";

import { archiveMode, archiveRoot } from "../src/env.ts";
import { listPartFiles, withConnection } from "../src/archive/duck.ts";
import { deleteFiles } from "../src/archive/s3.ts";
import { compactTimestamp, DESCRIBED_TYPES, MESSAGE_COLUMNS } from "../src/archive/schema.ts";

const day = process.argv[2] ?? "";
if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())) {
  console.error("Usage: npm run archive:compact -- YYYY-MM-DD");
  process.exit(1);
}
if (archiveMode === "off") {
  console.error("ARCHIVE_DIR=off, so there is no archive to compact.");
  process.exit(1);
}

const isS3 = archiveRoot.startsWith("s3://");
let merged = 0;
let failures = 0;

await withConnection(async (connection) => {
  const all = await listPartFiles(connection, archiveRoot);
  const byHour = new Map<string, string[]>();
  for (const file of all) {
    const match = /\/dt=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\/[^/]+\.parquet$/.exec(file);
    if (!match || match[1] !== day) continue;
    const hour = match[2]!;
    byHour.set(hour, [...(byHour.get(hour) ?? []), file]);
  }

  if (byHour.size === 0) {
    console.log(`No files for dt=${day}.`);
    return;
  }

  for (const [hour, files] of [...byHour.entries()].sort()) {
    if (files.length < 2) {
      console.log(`hour=${hour}: 1 file, nothing to merge`);
      continue;
    }

    const dir = `${archiveRoot}/messages/dt=${day}/hour=${hour}`;
    const name = `part-${compactTimestamp(new Date())}-${randomUUID()}.parquet`;
    const output = `${dir}/${name}`;
    const target = isS3 ? output : `${dir}/.${name}.tmp`;
    const list = listValue(files);

    try {
      const before = await connection.runAndReadAll(
        "SELECT count(*) AS n FROM read_parquet($files, hive_partitioning = false)",
        { files: list },
        { files: LIST(VARCHAR) },
      );
      const expected = Number(before.getRowObjectsJS()[0]?.n ?? -1);

      await connection.run(
        "COPY (SELECT * FROM read_parquet($files, hive_partitioning = false) ORDER BY recorded_at, archive_id) " +
          "TO $target (FORMAT parquet, COMPRESSION zstd)",
        { files: list, target },
        { files: LIST(VARCHAR) },
      );

      const after = await connection.runAndReadAll(
        "SELECT count(*) AS n FROM read_parquet($target, hive_partitioning = false)",
        { target },
      );
      const actual = Number(after.getRowObjectsJS()[0]?.n ?? -2);

      const described = await connection.runAndReadAll(
        "DESCRIBE SELECT * FROM read_parquet($target, hive_partitioning = false)",
        { target },
      );
      const schema = described.getRowObjectsJS().map((row) => `${String(row.column_name)}:${String(row.column_type)}`);
      const wanted = MESSAGE_COLUMNS.map((column) => `${column.name}:${DESCRIBED_TYPES[column.type]}`);

      if (actual !== expected || schema.join(",") !== wanted.join(",")) {
        await deleteFiles([target]);
        failures += 1;
        console.error(
          `hour=${hour}: verification failed (expected ${expected} rows, got ${actual}; schema ${schema.join(",") === wanted.join(",") ? "ok" : "mismatch"}). Originals kept.`,
        );
        continue;
      }

      if (!isS3) renameSync(target, output);
      await deleteFiles(files);
      merged += files.length;
      console.log(`hour=${hour}: merged ${files.length} files (${actual} rows) into ${name}`);
    } catch (error) {
      failures += 1;
      if (!isS3) rmSync(target, { force: true });
      console.error(`hour=${hour}: ${String(error)}. Originals kept.`);
    }
  }
});

console.log(`\nDone: ${merged} file(s) merged${failures > 0 ? `, ${failures} hour(s) failed` : ""}.`);
process.exit(failures > 0 ? 1 : 0);
