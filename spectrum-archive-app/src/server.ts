import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Message, Space } from "spectrum-ts";

import { type ApiOptions, handleApi } from "./api/routes.ts";
import { archiver } from "./archive/writer.ts";
import { archiveMode } from "./env.ts";
import { respondFromWebhook } from "./respond.ts";

// The raw `{ headers, body }` overload of `app.webhook()`, which is the one
// meant for plain Node servers. Typed structurally so this module does not
// depend on which provider combination built the app.
type WebhookCapable = {
  webhook(
    request: { body: Uint8Array; headers?: Record<string, string> },
    handler: (space: Space, message: Message) => void | Promise<void>,
  ): Promise<{ body: Uint8Array; headers: Record<string, string>; status: number }>;
};

// Must be the exact bytes POSTed: the HMAC covers them, and a re-encoded JSON
// body would fail verification.
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers[key] = value;
    else if (Array.isArray(value)) headers[key] = value.join(", ");
  }
  return headers;
}

export interface WebhookServerOptions {
  app: WebhookCapable;
  port: number;
  path: string;
  /**
   * Meta requires a GET handshake echoing `hub.challenge` before it will
   * register a callback URL. Spectrum does not implement it, so answer it here
   * when a token is configured.
   */
  metaVerifyToken?: string;
  /** Blank → the /api routes answer 404 "API is off". */
  apiKey?: string;
  /** Tests inject an archive source here. */
  apiSource?: ApiOptions["source"];
}

export function startWebhookServer(options: WebhookServerOptions): Promise<Server> {
  const { app, port, path, metaVerifyToken, apiKey, apiSource } = options;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/health") {
        const status = archiver?.status();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end(
          JSON.stringify({
            ok: true,
            archive: {
              mode: archiveMode,
              bufferSize: status?.bufferSize ?? 0,
              lastFlushAt: status?.lastFlushAt ?? null,
              lastFlushRows: status?.lastFlushRows ?? 0,
              lastFlushError: status?.lastFlushError ?? null,
            },
          }),
        );
        return;
      }

      // Meta's subscription handshake.
      if (req.method === "GET" && url.pathname === path) {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge") ?? "";

        if (metaVerifyToken && mode === "subscribe" && token === metaVerifyToken) {
          console.log("[webhook] Meta verification handshake accepted");
          res.writeHead(200, { "content-type": "text/plain" }).end(challenge);
        } else {
          console.log("[webhook] Meta verification handshake rejected");
          res.writeHead(403).end();
        }
        return;
      }

      if (await handleApi(req, res, url, { apiKey, source: apiSource })) return;

      if (req.method !== "POST" || url.pathname !== path) {
        res.writeHead(404).end();
        return;
      }

      try {
        const body = await readBody(req);
        const result = await app.webhook({ body, headers: flattenHeaders(req) }, respondFromWebhook);
        res.writeHead(result.status, result.headers).end(Buffer.from(result.body));
      } catch (error) {
        console.error("[webhook] delivery failed", error);
        res.writeHead(500).end();
      }
    })().catch((error: unknown) => {
      console.error("[server] request failed", error);
      if (!res.headersSent) res.writeHead(500).end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      console.log(`[webhook] listening on http://localhost:${actual}${path}`);
      resolve(server);
    });
  });
}
