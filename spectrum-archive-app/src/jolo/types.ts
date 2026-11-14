// The bridge ↔ agent contract, as types. Source of truth: docs/contracts.md §2.

export type Role = "owner" | "customer";
export type Scope = "full" | "partial";

export interface MenuItem {
  id?: string;
  name: string;
  category?: string | null;
  priceCents?: number | null;
  description?: string | null;
  available?: boolean;
}

export interface FieldChange {
  name: string;
  field: string;
  from: unknown;
  to: unknown;
}

export interface MenuChanges {
  added: MenuItem[];
  changed: FieldChange[];
  removed: MenuItem[];
}

export interface Photo {
  name: string;
  mime_type: string;
  data_base64: string;
}

export type TurnEvent =
  | { type: "message"; text: string; photos: Photo[] }
  | { type: "scope"; scope: Scope }
  | { type: "confirm"; confirmed: boolean };

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
  | { type: "not_owner" };

/** Per-conversation state the bridge keeps (in the memory store, keyed by space id). */
export interface JoloState {
  name?: string;
  role?: Role;
  /** Which onboarding question is waiting for an answer. */
  onboarding?: "name" | "role";
  /** Which owner question is waiting for an answer. */
  pending?: "scope" | "confirm";
  /** A photo arrived before onboarding finished; ask for it again afterwards. */
  heldPhoto?: boolean;
}
