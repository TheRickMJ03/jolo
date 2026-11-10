import {
  apiKey,
  archiveFlushIntervalMs,
  archiveFlushMaxRows,
  archiveMode,
  archiveRoot,
  metaVerifyToken,
  projectId,
  projectSecret,
  telegramBotToken,
  webhookPath,
  webhookPort,
  webhookSecret,
  whatsappAccessToken,
  whatsappAppSecret,
  whatsappPhoneNumberId,
} from "./env.ts"; // FIRST: loads .env before the SDK reads process.env

import { Spectrum } from "spectrum-ts";
import { imessage } from "spectrum-ts/providers/imessage";
import { telegram } from "spectrum-ts/providers/telegram";
import { terminal } from "spectrum-ts/providers/terminal";
import { whatsappBusiness } from "spectrum-ts/providers/whatsapp-business";

import { archiver } from "./archive/writer.ts";
import { respond } from "./respond.ts";
import { startWebhookServer } from "./server.ts";
import { flush as flushStore } from "./store.ts";

// Spectrum bridges a single agent loop to many messaging interfaces.
// Docs: https://photon.codes/docs/spectrum-ts

// The terminal provider is projectless: no credentials, no phone line. It is
// the one surface that always works, so the app is testable before cloud
// setup is finished. The rest join only when their credentials are present.
const terminalProvider = terminal.config({
  commands: [
    { name: "/ping", description: "Check the agent is alive" },
    { name: "/whoami", description: "Print sender and platform details" },
    { name: "/help", description: "List what this app does" },
    { name: "/reset", description: "Forget this conversation" },
  ],
});

// Telegram needs a bot token from @BotFather AND project credentials: its
// inbound stream runs through Fusor, which throws without them and would take
// the whole message loop down with it. So it is gated on both.
const hasCloudCredentials = Boolean(projectId && projectSecret);
const telegramProvider =
  telegramBotToken && hasCloudCredentials
    ? telegram.config({ botToken: telegramBotToken })
    : undefined;

// WhatsApp Business runs in direct mode off its own Meta credentials, so
// unlike Telegram it does not need a project. All three values are required.
const whatsappProvider =
  whatsappAccessToken && whatsappPhoneNumberId && whatsappAppSecret
    ? whatsappBusiness.config({
        accessToken: whatsappAccessToken,
        phoneNumberId: whatsappPhoneNumberId,
        appSecret: whatsappAppSecret,
      })
    : undefined;

// Start the archive before any message can arrive: this replays rows a crash
// left in the spool and starts the interval flusher.
archiver?.start();

// Two separate calls rather than one conditional array: Spectrum types the
// credentialled and projectless forms as distinct overloads.
const app =
  projectId && projectSecret
    ? await Spectrum({
        projectId,
        projectSecret,
        webhookSecret,
        providers: [
          terminalProvider,
          imessage.config(),
          ...(telegramProvider ? [telegramProvider] : []),
          ...(whatsappProvider ? [whatsappProvider] : []),
        ],
      })
    : await Spectrum({
        webhookSecret,
        providers: [
          terminalProvider,
          ...(whatsappProvider ? [whatsappProvider] : []),
        ],
      });

// ---------------------------------------------------------------------------
// Shutdown. One path flushes both the memory store and the archive; each is
// isolated, so one failing never skips the other. Even if this never gets to
// run (kill -9, power loss), unflushed archive rows are safe in the spool.
// ---------------------------------------------------------------------------
let shuttingDown: Promise<void> | undefined;

function shutdown(): Promise<void> {
  shuttingDown ??= (async () => {
    try {
      flushStore();
    } catch (error) {
      console.error(`[memory] flush on exit failed: ${String(error)}`);
    }
    try {
      if (archiver) {
        archiver.stop();
        const timeout = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("timed out after 15s; rows stay in the spool")), 15_000).unref();
        });
        const result = await Promise.race([archiver.flush(), timeout]);
        if (result.written > 0) console.log(`[archive] flushed ${result.written} row(s) on exit`);
      }
    } catch (error) {
      console.error(`[archive] flush on exit failed: ${String(error)}`);
    }
  })();
  return shuttingDown;
}

// Ctrl+C would otherwise discard whatever the debounce and buffer still held.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
process.once("beforeExit", () => {
  void shutdown();
});

// ---------------------------------------------------------------------------
// What's on, and why anything is off.
// ---------------------------------------------------------------------------
const active = ["terminal"];
if (hasCloudCredentials) active.push("imessage");
if (telegramProvider) active.push("telegram");
if (whatsappProvider) active.push("whatsapp");

console.log(`Spectrum up — ${active.join(", ")}. Type below to test.`);
if (!hasCloudCredentials) {
  console.log("No PROJECT_ID/PROJECT_SECRET in .env, so iMessage is off.");
}
if (!telegramBotToken) {
  console.log("No TELEGRAM_BOT_TOKEN in .env, so Telegram is off.");
} else if (!hasCloudCredentials) {
  console.log(
    "TELEGRAM_BOT_TOKEN is set but Telegram needs PROJECT_ID/PROJECT_SECRET " +
      "too (inbound runs through Fusor), so it is off.",
  );
}
if (!whatsappProvider) {
  console.log("No WA_TOKEN/WA_NUMBER_ID/WA_SECRET in .env, so WhatsApp is off.");
}

const flushEvery = `flush every ${Math.round(archiveFlushIntervalMs / 1000)}s or ${archiveFlushMaxRows} rows`;
if (archiveMode === "s3") {
  console.log(`Archive: Parquet to ${archiveRoot} (${flushEvery}).`);
} else if (archiveMode === "local") {
  console.log(`Archive: local Parquet in ${archiveRoot} (${flushEvery}). No S3_BUCKET in .env, so S3 is off.`);
} else {
  console.log("ARCHIVE_DIR=off in .env, so the archive is off: nothing is recorded.");
}

// The webhook is a second, independent inbound path: `app.webhook()` is
// stateless and never feeds `app.messages`, so both call the same `respond`.
if (webhookPort) {
  await startWebhookServer({
    app,
    port: webhookPort,
    path: webhookPath,
    metaVerifyToken,
    apiKey,
  });
  if (!webhookSecret) {
    console.log(
      "No SPECTRUM_WEBHOOK_SECRET in .env, so signed Spectrum Cloud deliveries to the webhook will fail (500).",
    );
  }
  if (apiKey) {
    console.log(`Query API on at http://localhost:${webhookPort}/api (X-API-Key header required).`);
    if (apiKey.length < 24) console.log("API_KEY is shorter than 24 characters; use `openssl rand -hex 32`.");
  } else {
    console.log("No API_KEY in .env, so the query/send API is off (the webhook still works).");
  }
} else {
  console.log("No WEBHOOK_PORT in .env, so the webhook server is off, and the query API with it.");
}

// `app.messages` is an async iterable. Each tick yields a `space` (the
// conversation) and an inbound `message`.
for await (const [space, message] of app.messages) {
  await respond(space, message, "stream");
}
