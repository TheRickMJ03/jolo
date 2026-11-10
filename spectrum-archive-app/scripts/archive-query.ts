// `npm run archive:query -- "<SQL>"` — ad-hoc SQL against the archive root.
//
// Two relations are available:
//   messages  every archived row: the Parquet files plus anything still in
//             the spool (not yet flushed). Has the hive columns dt and hour,
//             which are NULL for spool rows.
//   spool     only the unflushed rows from the spool file.
//
// This is an operator tool for your own archive, so it runs whatever SQL you
// give it. It opens the archive read-only in intent but does not sandbox you.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { archiveMode, archiveRoot, archiveSpoolDir } from "../src/env.ts";
import { insertRows, listPartFiles, sqlString, withConnection } from "../src/archive/duck.ts";
import { COLUMN_NAMES, createTableSql, fromSpoolLine, type MessageRow } from "../src/archive/schema.ts";

const sql = process.argv.slice(2).join(" ").trim();

if (!sql) {
  console.log(`Usage: npm run archive:query -- "<SQL>"

Archive root: ${archiveRoot}

Examples:
  npm run archive:query -- "SELECT platform, direction, count(*) AS n FROM messages GROUP BY ALL ORDER BY n DESC"
  npm run archive:query -- "SELECT recorded_at, space_id, text FROM messages WHERE text ILIKE '%hello%' ORDER BY recorded_at DESC LIMIT 20"
  npm run archive:query -- "SELECT dt, hour, count(*) FROM messages GROUP BY ALL ORDER BY ALL"
  npm run archive:query -- "SELECT * FROM spool"`);
  process.exit(0);
}

if (archiveMode === "off") {
  console.error("ARCHIVE_DIR=off, so there is no archive to query.");
  process.exit(1);
}

function readSpool(): MessageRow[] {
  const file = join(archiveSpoolDir, "messages.jsonl");
  if (!existsSync(file)) return [];
  const rows: MessageRow[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(fromSpoolLine(line));
    } catch {
      // torn line; the app's own replay skips it too
    }
  }
  return rows;
}

try {
  await withConnection(async (connection) => {
    await connection.run(createTableSql("spool"));
    await insertRows(connection, "spool", readSpool());

    const columns = COLUMN_NAMES.join(", ");
    const files = await listPartFiles(connection, archiveRoot);
    // A view, so DuckDB prunes partitions when you filter on dt/hour. The root
    // is operator config, quoted as a literal because views cannot hold bind
    // parameters.
    const parquet =
      files.length > 0
        ? `SELECT ${columns}, dt, hour FROM read_parquet(${sqlString(`${archiveRoot}/messages/dt=*/hour=*/*.parquet`)}, ` +
          `hive_partitioning = true, hive_types = {'dt': DATE, 'hour': INTEGER}) UNION ALL BY NAME `
        : "";
    await connection.run(`CREATE TEMP VIEW messages AS ${parquet}SELECT ${columns} FROM spool`);

    const reader = await connection.runAndReadAll(sql);
    const rows = reader.getRowObjectsJson();
    if (rows.length === 0) {
      console.log("(no rows)");
    } else {
      console.table(rows);
      console.log(`${rows.length} row(s)`);
    }
  });
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
