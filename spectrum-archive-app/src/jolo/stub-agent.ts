// A STAND-IN for Bhavesh's agent, implementing POST /v1/turn from
// docs/contracts.md with one fake café, so the bridge's whole flow (the
// sequence diagram, steps 1–27) runs before the real agent exists.
//
// It does not read photos: any photo "contains" the same fixed changes
// (2 new items, 3 price changes, Croissant missing). Two photo names stand in
// for the reader's failures: a name containing "blurry" is unreadable, and one
// containing "offline" means the model server is down. Nothing is persisted.
import { createServer, type IncomingMessage, type Server } from "node:http";

import type { AgentAction, MenuChanges, MenuItem, PriceChange, Scope, TurnRequest } from "./types.ts";

export interface StubOptions {
  /** Sender handles that own the fake café. */
  ownerHandles: readonly string[];
  /** Required bearer token, if any. */
  token?: string;
}

interface Session {
  phase: "idle" | "await_scope" | "await_confirm";
  scope?: Scope;
  /** Owner fixes to the proposal, by item id: the price they gave. */
  fixes: Map<string, number>;
  next?: MenuItem[];
}

const CAFE_NAME = "Barbara's";

const item = (id: string, name: string, section: string, category: string, usd: number, confidence = 1): MenuItem => ({
  id,
  section,
  item: name,
  category,
  prices: [{ size: null, usd }],
  confidence,
  available: true,
});

const VERSION_3: MenuItem[] = [
  item("espresso", "Espresso", "Coffee", "drink", 3),
  item("cortado", "Cortado", "Coffee", "drink", 4.5),
  {
    ...item("latte", "Latte", "Coffee", "drink", 0),
    prices: [
      { size: "12 oz", usd: 3.5 },
      { size: "16 oz", usd: 4.25 },
    ],
  },
  item("cappuccino", "Cappuccino", "Coffee", "drink", 4),
  item("muffin", "Muffin", "Bakery", "food", 3.25),
  item("croissant", "Croissant", "Bakery", "food", 3.75),
];

/** What the stub pretends every photo shows. Matcha is the one the "reader" is least sure of. */
const PHOTO_ADDS: MenuItem[] = [
  item("oat-latte", "Oat Latte", "Coffee", "drink", 5, 0.9),
  item("matcha", "Matcha", "Tea", "drink", 5.25, 0.55),
];
const PHOTO_PRICES: Record<string, number> = { cortado: 4.75, cappuccino: 4.25, muffin: 3.5 };
const PHOTO_MISSING = ["croissant"];

const money = (usd: number) => `$${usd.toFixed(2)}`;
const priceText = (entry: MenuItem) =>
  entry.prices?.length
    ? entry.prices.map((price) => (price.size ? `${price.size} ${money(price.usd)}` : money(price.usd))).join(" / ")
    : "ask in store";

/** The comparison the reader's `changes` makes, between two whole menus. */
function diff(before: MenuItem[], after: MenuItem[]): MenuChanges {
  const old = new Map(before.map((entry) => [entry.id, entry]));
  const kept = new Set(after.map((entry) => entry.id));
  const price_changes: PriceChange[] = [];
  for (const entry of after) {
    const previous = old.get(entry.id);
    if (!previous) continue;
    for (const price of entry.prices ?? []) {
      const was = previous.prices?.find((p) => (p.size ?? null) === (price.size ?? null));
      if (was?.usd !== price.usd) {
        price_changes.push({ item: entry.item, size: price.size ?? null, old_usd: was?.usd ?? null, new_usd: price.usd });
      }
    }
  }
  return {
    added: after.filter((entry) => !old.has(entry.id)),
    price_changes,
    removed: before.filter((entry) => !kept.has(entry.id)).map((entry) => entry.item),
  };
}

export function createStubAgent(options: StubOptions): Server {
  let menu = VERSION_3.map((entry) => ({ ...entry }));
  let version = 3;
  let updatedAt = new Date(Date.now() - 3 * 86_400_000);
  const sessions = new Map<string, Session>();

  function propose(session: Session): AgentAction {
    const priced = (entry: MenuItem): MenuItem => {
      const usd = session.fixes.get(entry.id ?? "") ?? PHOTO_PRICES[entry.id ?? ""];
      // The stub only reprices single-price items; Latte keeps its two sizes.
      return usd === undefined || entry.prices?.length !== 1 ? entry : { ...entry, prices: [{ size: null, usd }] };
    };
    const dropped = session.scope === "full" ? PHOTO_MISSING : [];
    session.next = [
      ...menu.filter((entry) => !dropped.includes(entry.id ?? "")),
      ...PHOTO_ADDS.filter((add) => !menu.some((entry) => entry.id === add.id)),
    ].map(priced);
    session.phase = "await_confirm";
    return { type: "confirm_changes", cafe_name: CAFE_NAME, changes: diff(menu, session.next) };
  }

  /** "the cortado is 4.50" → the proposal's Cortado costs $4.50. A real agent would use the LLM. */
  function applyFix(session: Session, text: string): boolean {
    const amount = text.match(/(\d+(?:\.\d{1,2})?)/);
    const lower = text.toLowerCase();
    const target = (session.next ?? []).find((entry) => lower.includes(entry.item.toLowerCase()));
    if (!amount || !target?.id) return false;
    session.fixes.set(target.id, Number(amount[1]));
    return true;
  }

  function menuText(): string {
    const days = Math.floor((Date.now() - updatedAt.getTime()) / 86_400_000);
    const when = days === 0 ? "updated today" : `updated ${days} day${days === 1 ? "" : "s"} ago`;
    const items = menu.map((entry) => `${entry.item} ${priceText(entry)}`).join(", ");
    return `${CAFE_NAME}: ${items} (${when})`;
  }

  function turn(request: TurnRequest): AgentAction[] {
    const session: Session = sessions.get(request.conversation_id) ?? { phase: "idle", fixes: new Map() };
    sessions.set(request.conversation_id, session);
    const isOwner = options.ownerHandles.includes(request.sender.handle);
    const { event } = request;

    if (event.type === "message") {
      if (event.photos.length > 0) {
        if (!isOwner) return [{ type: "not_owner" }];
        const names = event.photos.map((photo) => photo.name.toLowerCase());
        if (names.some((name) => name.includes("offline"))) return [{ type: "reader_down" }];
        if (names.some((name) => name.includes("blurry"))) return [{ type: "unreadable_photo", reason: "blurry" }];
        // Another photo of a menu that's already being confirmed is merged in
        // and the summary sent again; otherwise the scope question comes first.
        if (session.phase === "await_confirm") return [propose(session)];
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
      session.scope = event.scope;
      return [propose(session)];
    }

    if (event.type === "correction" && session.phase === "await_confirm") {
      if (applyFix(session, event.text)) return [propose(session)];
      return [{ type: "say", text: 'I couldn\'t work out that fix. Try it like "the cortado is 4.50".' }, propose(session)];
    }

    if (event.type === "confirm" && session.phase === "await_confirm" && session.next) {
      const next = session.next;
      sessions.delete(request.conversation_id);
      if (!event.confirmed) return [{ type: "cancelled" }];
      menu = next;
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
