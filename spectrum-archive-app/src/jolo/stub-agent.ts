// A STAND-IN for Bhavesh's agent, implementing POST /v1/turn from
// docs/contracts.md with one fake café, so the bridge's whole flow (the
// sequence diagram, steps 1–27) runs before the real agent exists.
//
// It does not read photos: any photo "contains" the same fixed changes
// (2 new items, 3 price changes, Croissant missing). Nothing here is persisted.
import { createServer, type IncomingMessage, type Server } from "node:http";

import type { AgentAction, MenuChanges, MenuItem, Scope, TurnRequest } from "./types.ts";

export interface StubOptions {
  /** Sender handles that own the fake café. */
  ownerHandles: readonly string[];
  /** Required bearer token, if any. */
  token?: string;
}

interface Session {
  phase: "idle" | "await_scope" | "await_confirm";
  proposal?: { changes: MenuChanges; next: MenuItem[] };
}

const CAFE_NAME = "Barbara's";

const VERSION_3: MenuItem[] = [
  { id: "espresso", name: "Espresso", category: "Coffee", priceCents: 300, available: true },
  { id: "cortado", name: "Cortado", category: "Coffee", priceCents: 450, available: true },
  { id: "latte", name: "Latte", category: "Coffee", priceCents: 350, available: true },
  { id: "cappuccino", name: "Cappuccino", category: "Coffee", priceCents: 400, available: true },
  { id: "muffin", name: "Muffin", category: "Bakery", priceCents: 325, available: true },
  { id: "croissant", name: "Croissant", category: "Bakery", priceCents: 375, available: true },
];

/** What the stub pretends every photo shows. */
const PHOTO_ADDS: MenuItem[] = [
  { id: "oat-latte", name: "Oat Latte", category: "Coffee", priceCents: 500, available: true },
  { id: "matcha", name: "Matcha", category: "Tea", priceCents: 525, available: true },
];
const PHOTO_PRICES: Record<string, number> = { cortado: 475, cappuccino: 425, muffin: 350 };
const PHOTO_MISSING = ["croissant"];

const money = (cents: number | null | undefined) =>
  typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "ask in store";

export function createStubAgent(options: StubOptions): Server {
  let menu = VERSION_3.map((item) => ({ ...item }));
  let version = 3;
  let updatedAt = new Date(Date.now() - 3 * 86_400_000);
  const sessions = new Map<string, Session>();

  function propose(scope: Scope): { changes: MenuChanges; next: MenuItem[] } {
    const changed = menu
      .filter((item) => item.id && PHOTO_PRICES[item.id] !== undefined && PHOTO_PRICES[item.id] !== item.priceCents)
      .map((item) => ({ name: item.name, field: "priceCents", from: item.priceCents, to: PHOTO_PRICES[item.id!] }));
    const added = PHOTO_ADDS.filter((add) => !menu.some((item) => item.id === add.id));
    const removed = scope === "full" ? menu.filter((item) => PHOTO_MISSING.includes(item.id ?? "")) : [];

    const next = [
      ...menu
        .filter((item) => !removed.includes(item))
        .map((item) => ({ ...item, priceCents: PHOTO_PRICES[item.id ?? ""] ?? item.priceCents })),
      ...added,
    ];
    return { changes: { added, changed, removed }, next };
  }

  function menuText(): string {
    const days = Math.floor((Date.now() - updatedAt.getTime()) / 86_400_000);
    const when = days === 0 ? "updated today" : `updated ${days} day${days === 1 ? "" : "s"} ago`;
    const items = menu.map((item) => `${item.name} ${money(item.priceCents)}`).join(", ");
    return `${CAFE_NAME}: ${items} (${when})`;
  }

  function turn(request: TurnRequest): AgentAction[] {
    const session = sessions.get(request.conversation_id) ?? { phase: "idle" };
    sessions.set(request.conversation_id, session);
    const isOwner = options.ownerHandles.includes(request.sender.handle);
    const { event } = request;

    if (event.type === "message") {
      if (event.photos.length > 0) {
        if (!isOwner) return [{ type: "not_owner" }];
        session.phase = "await_scope";
        return [{ type: "ask_scope" }];
      }
      const text = event.text.toLowerCase();
      if (isOwner && /\bupdate\b/.test(text)) {
        return [{ type: "say", text: "Send me a photo of your menu and I'll read it." }];
      }
      if (/menu|barbara|price|cost|how much/.test(text)) return [{ type: "say", text: menuText() }];
      return [{ type: "say", text: `I can tell you what's on the menu at ${CAFE_NAME}. Try "What's on the menu at Barbara's?"` }];
    }

    if (!isOwner) return [{ type: "not_owner" }];

    if (event.type === "scope" && session.phase === "await_scope") {
      session.proposal = propose(event.scope);
      session.phase = "await_confirm";
      return [{ type: "confirm_changes", cafe_name: CAFE_NAME, changes: session.proposal.changes }];
    }

    if (event.type === "confirm" && session.phase === "await_confirm" && session.proposal) {
      const proposal = session.proposal;
      sessions.delete(request.conversation_id);
      if (!event.confirmed) return [{ type: "cancelled" }];
      menu = proposal.next;
      version += 1;
      updatedAt = new Date();
      return [{ type: "menu_updated", cafe_name: CAFE_NAME, version }];
    }

    return [{ type: "say", text: "Let's start over: send me a photo of your menu." }];
  }

  return createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || req.url !== "/v1/turn") {
        res.writeHead(404).end();
        return;
      }
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) {
        res.writeHead(401, { "content-type": "application/json" }).end('{"error":"bad token"}');
        return;
      }
      let request: TurnRequest;
      try {
        request = JSON.parse((await readBody(req)).toString("utf8")) as TurnRequest;
        if (!request?.event || !request.sender?.handle || !request.conversation_id) throw new Error("shape");
      } catch {
        res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad request"}');
        return;
      }
      const actions = turn(request);
      console.log(`[stub-agent] ${request.sender.handle} ${request.event.type} → ${actions.map((a) => a.type).join(", ")}`);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ actions }));
    })();
  });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
