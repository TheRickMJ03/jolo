// Imported FIRST by every test file, so it runs before env.ts — the same
// load-order trick index.ts uses. Each test file is its own process under
// `node --test`, so each gets its own temp archive.
//
// No credentials, no network, no AWS: every provider and the LLM are blanked,
// .env is never read, and the archive is local Parquet in a temp folder.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testDir = mkdtempSync(join(tmpdir(), "spectrum-archive-test-"));

Object.assign(process.env, {
  SKIP_DOTENV: "1",
  PROJECT_ID: "",
  PROJECT_SECRET: "",
  TELEGRAM_BOT_TOKEN: "",
  SPECTRUM_TELEGRAM_BOT_TOKEN: "",
  WA_TOKEN: "",
  WA_NUMBER_ID: "",
  WA_SECRET: "",
  SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN: "",
  SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID: "",
  SPECTRUM_WHATSAPP_BUSINESS_APP_SECRET: "",
  WEBHOOK_PORT: "",
  LLM_MODEL: "",
  MEMORY_FILE: "off",
  S3_BUCKET: "",
  AWS_ACCESS_KEY_ID: "",
  AWS_SECRET_ACCESS_KEY: "",
  ARCHIVE_DIR: join(testDir, "archive"),
  ARCHIVE_SPOOL_DIR: join(testDir, "spool"),
  // The tests flush explicitly; keep the background flusher out of the way.
  ARCHIVE_FLUSH_INTERVAL_MS: "3600000",
  ARCHIVE_FLUSH_MAX_ROWS: "100000",
  API_KEY: "",
});

process.on("exit", () => {
  rmSync(testDir, { recursive: true, force: true });
});
