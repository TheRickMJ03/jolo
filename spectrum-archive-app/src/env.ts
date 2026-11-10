// Loads .env before any other module reads process.env.
// Imported first from index.ts so its side effect runs ahead of the SDK.
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

// SKIP_DOTENV=1 is for the test suite only, so a developer's real .env can
// never leak credentials or an LLM_MODEL into a test run.
if (existsSync(envPath) && process.env.SKIP_DOTENV !== "1") {
  process.loadEnvFile(envPath);
}

const read = (name: string) => process.env[name]?.trim() || undefined;

/** Relative paths are taken from the project root, absolute ones as given. */
const fromRoot = (path: string) => (isAbsolute(path) ? path : resolve(projectRoot, path));

const positiveInt = (name: string, fallback: number) => {
  const value = Number(read(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

export const projectId = read("PROJECT_ID");
export const projectSecret = read("PROJECT_SECRET");

// The SDK's own fallback is SPECTRUM_TELEGRAM_BOT_TOKEN; accept the shorter
// name too, since that is what the Telegram docs use in their examples.
export const telegramBotToken =
  read("SPECTRUM_TELEGRAM_BOT_TOKEN") ?? read("TELEGRAM_BOT_TOKEN");

// WhatsApp Business direct mode. The SDK's own fallbacks are the
// SPECTRUM_WHATSAPP_BUSINESS_* names; the shorter ones match the docs examples.
export const whatsappAccessToken =
  read("SPECTRUM_WHATSAPP_BUSINESS_ACCESS_TOKEN") ?? read("WA_TOKEN");
export const whatsappPhoneNumberId =
  read("SPECTRUM_WHATSAPP_BUSINESS_PHONE_NUMBER_ID") ?? read("WA_NUMBER_ID");
export const whatsappAppSecret =
  read("SPECTRUM_WHATSAPP_BUSINESS_APP_SECRET") ?? read("WA_SECRET");

// Webhook server. Off unless a port is set, so terminal-only runs stay quiet.
const port = Number(read("WEBHOOK_PORT"));
export const webhookPort = Number.isInteger(port) && port > 0 ? port : undefined;
export const webhookPath = read("WEBHOOK_PATH") ?? "/spectrum/webhook";

// Verifies the HMAC on native Spectrum Cloud webhook deliveries.
export const webhookSecret = read("SPECTRUM_WEBHOOK_SECRET");

// Echoed back during Meta's callback-URL handshake.
export const metaVerifyToken = read("WA_VERIFY_TOKEN");

// LLM backend, spoken as OpenAI-compatible chat completions. Unset LLM_MODEL
// leaves the app echoing. Ollama's default base URL is below; a hosted
// provider needs its own base URL, model name and key.
export const llmModel = read("LLM_MODEL");
export const llmBaseUrl = (read("LLM_BASE_URL") ?? "http://localhost:11434/v1").replace(/\/+$/, "");
export const llmApiKey = read("LLM_API_KEY");

export const llmTimeoutMs = positiveInt("LLM_TIMEOUT_MS", 120_000);

// Turns sent back to the model. CPU inference slows down as this grows.
export const llmHistoryTurns = positiveInt("LLM_HISTORY_TURNS", 12);

export const llmSystemPrompt =
  read("LLM_SYSTEM_PROMPT") ??
  "You are a helpful assistant replying over a messaging app. " +
    "Keep replies to a few sentences unless asked for more. Plain text only.";

// Ceiling on model calls per inbound message, so a tool-calling loop that
// never converges cannot run up the bill on its own.
export const llmMaxSteps = positiveInt("LLM_MAX_STEPS", 5);

// Where conversations and notes are kept between runs. MEMORY_FILE=off keeps
// everything in memory.
const memoryPath = read("MEMORY_FILE") ?? "data/memory.json";
export const memoryEnabled = memoryPath.toLowerCase() !== "off";
export const memoryFile = fromRoot(memoryPath);

// ---------------------------------------------------------------------------
// Archive. Blank S3_BUCKET → local Parquet in ARCHIVE_DIR. ARCHIVE_DIR=off
// disables the archive entirely, whether or not S3_BUCKET is set.
// ---------------------------------------------------------------------------
export const s3Bucket = read("S3_BUCKET");
export const s3Prefix = (read("S3_PREFIX") ?? "spectrum-archive").replace(/^\/+|\/+$/g, "");
export const awsRegion = read("AWS_REGION") ?? "us-east-1";
// Blank keys → DuckDB and the AWS SDK fall back to the default credential
// chain (AWS_PROFILE, SSO, instance role, …).
export const awsAccessKeyId = read("AWS_ACCESS_KEY_ID");
export const awsSecretAccessKey = read("AWS_SECRET_ACCESS_KEY");
export const awsSessionToken = read("AWS_SESSION_TOKEN");

const archiveDirSetting = read("ARCHIVE_DIR") ?? "data/archive";
export const archiveMode: "s3" | "local" | "off" =
  archiveDirSetting.toLowerCase() === "off" ? "off" : s3Bucket ? "s3" : "local";

/** `s3://bucket/prefix` or an absolute local directory. Same code path for both. */
export const archiveRoot =
  archiveMode === "s3"
    ? `s3://${s3Bucket}${s3Prefix ? `/${s3Prefix}` : ""}`
    : fromRoot(archiveDirSetting);

export const archiveSpoolDir = fromRoot(read("ARCHIVE_SPOOL_DIR") ?? "data/spool");
export const archiveFlushIntervalMs = positiveInt("ARCHIVE_FLUSH_INTERVAL_MS", 30_000);
export const archiveFlushMaxRows = positiveInt("ARCHIVE_FLUSH_MAX_ROWS", 500);
export const archiveExpireDays = positiveInt("ARCHIVE_EXPIRE_DAYS", 14);

// Query/send API. Blank API_KEY → the /api routes are off (webhook still works).
export const apiKey = read("API_KEY");
