// The bridge ↔ agent contract, as types. Source of truth: docs/contracts.md §2.

export type Role = "owner" | "customer";
export type Scope = "full" | "partial";

/** One price of an item, as the menu reader returns it (menu_reader/schema.py). */
export interface Price {
  /** "8 oz", "Small", "min"/"max" for a range; null when the menu shows no size. */
  size?: string | null;
  usd: number;
}

/**
 * A menu item in the reader's shape (docs/contracts.md §1). The reader's field
 * names are kept as they are; `id` and `available` are added when it's stored.
 */
export interface MenuItem {
  id?: string;
  section?: string | null;
  item: string;
  category?: string;
  prices?: Price[];
  /** 0–1, a ranking aid: lower means "ask the owner about this one first". */
  confidence?: number;
  available?: boolean;
}

/** The reader's PriceChange: old_usd is null for a new size, new_usd for a size that's gone. */
export interface PriceChange {
  item: string;
  size?: string | null;
  old_usd?: number | null;
  new_usd?: number | null;
}

export interface MenuChanges {
  added: MenuItem[];
  price_changes: PriceChange[];
  /** Names of items leaving the menu (only when the owner said the photo is the full menu). */
  removed: string[];
}

export interface Photo {
  name: string;
  mime_type: string;
  data_base64: string;
}

export type TurnEvent =
  | { type: "message"; text: string; photos: Photo[] }
  | { type: "scope"; scope: Scope }
  | { type: "confirm"; confirmed: boolean }
  /** The owner answered the change summary with a fix ("no, the cortado is 4.50"). */
  | { type: "correction"; text: string };

export interface TurnRequest {
  conversation_id: string;
  platform: string;
  sender: { handle: string; name: string | null; role: Role | null };
  event: TurnEvent;
}

export type AgentAction =
  | { type: "say"; text: string }
  | { type: "ask_scope" }
  | { type: "confirm_changes"; cafe_name?: string; changes: MenuChanges }
  | { type: "menu_updated"; cafe_name?: string; version?: number }
  | { type: "cancelled" }
  | { type: "not_owner" }
  /** The reader returned readable: false for the photo itself. */
  | { type: "unreadable_photo"; reason?: string }
  /** The reader's model server didn't answer (reason "model_error: …"). */
  | { type: "reader_down" };

/** Per-conversation state the bridge keeps (in the memory store, keyed by space id). */
export interface JoloState {
  name?: string;
  role?: Role;
  /** Which onboarding question is waiting for an answer. */
  onboarding?: "name" | "role";
  /** Which owner question is waiting for an answer. */
  pending?: "scope" | "confirm";
  /** A menu update is open: more photos join it instead of starting a new one. */
  updating?: boolean;
  /** A photo arrived before onboarding finished; ask for it again afterwards. */
  heldPhoto?: boolean;
}
