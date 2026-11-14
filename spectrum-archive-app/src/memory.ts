// `npm run memory` / `npm run memory:clear` — inspect or wipe what is stored.
import { memoryEnabled, memoryFile } from "./env.ts";
import { dropEverything, summary } from "./store.ts";

const command = process.argv[2] ?? "show";

if (!memoryEnabled) {
  console.log("Memory is off (MEMORY_FILE=off). Nothing is stored between runs.");
  process.exit(0);
}

if (command === "clear") {
  const count = dropEverything();
  console.log(`Cleared ${count} conversation(s) from ${memoryFile}.`);
  process.exit(0);
}

if (command !== "show") {
  console.error(`Unknown command "${command}". Use "show" or "clear".`);
  process.exit(1);
}

const records = summary();
if (records.length === 0) {
  console.log(`Nothing stored in ${memoryFile}.`);
  process.exit(0);
}

console.log(`${records.length} conversation(s) in ${memoryFile}:\n`);
for (const record of records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
  console.log(
    `  ${record.id.padEnd(28)} ${String(record.turns).padStart(3)} turns  ` +
      `${String(record.notes).padStart(3)} notes  last ${record.updatedAt}`,
  );
}
