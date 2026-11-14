// HTTP client for Bhavesh's agent: POST {AGENT_URL}/v1/turn (docs/contracts.md §2).
import { agentTimeoutMs, agentToken, agentUrl } from "../env.ts";
import type { AgentAction, MenuChanges, TurnRequest } from "./types.ts";

export class AgentError extends Error {}

export interface AgentClient {
  turn(request: TurnRequest): Promise<AgentAction[]>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validChanges(value: unknown): value is MenuChanges {
  if (!isObject(value)) return false;
  const { added, changed, removed } = value;
  const named = (list: unknown) =>
    Array.isArray(list) && list.every((entry) => isObject(entry) && typeof entry.name === "string");
  return named(added) && named(removed) && named(changed) && (changed as unknown[]).every(
    (entry) => typeof (entry as Record<string, unknown>).field === "string",
  );
}

/**
 * Validates the agent's response. Known actions with bad fields throw (the
 * bridge then says "couldn't reach the menu service"); unknown action types
 * are dropped, so the agent can add new ones without breaking old bridges.
 */
export function parseActions(body: unknown): AgentAction[] {
  if (!isObject(body) || !Array.isArray(body.actions)) {
    throw new AgentError("response has no actions array");
  }
  const actions: AgentAction[] = [];
  for (const raw of body.actions) {
    if (!isObject(raw) || typeof raw.type !== "string") throw new AgentError("an action has no type");
    switch (raw.type) {
      case "say":
        if (typeof raw.text !== "string" || !raw.text.trim()) throw new AgentError("say without text");
        actions.push({ type: "say", text: raw.text });
        break;
      case "confirm_changes":
        if (!validChanges(raw.changes)) throw new AgentError("confirm_changes with malformed changes");
        actions.push({
          type: "confirm_changes",
          changes: raw.changes,
          ...(typeof raw.cafe_name === "string" ? { cafe_name: raw.cafe_name } : {}),
        });
        break;
      case "menu_updated":
        actions.push({
          type: "menu_updated",
          ...(typeof raw.cafe_name === "string" ? { cafe_name: raw.cafe_name } : {}),
          ...(typeof raw.version === "number" ? { version: raw.version } : {}),
        });
        break;
      case "ask_scope":
      case "cancelled":
      case "not_owner":
        actions.push({ type: raw.type });
        break;
      default:
        console.warn(`[jolo] ignoring unknown agent action "${raw.type}"`);
    }
  }
  return actions;
}

export function httpAgent(url: string, token: string | undefined, timeoutMs: number): AgentClient {
  return {
    async turn(request) {
      let response: Response;
      try {
        response = await fetch(`${url}/v1/turn`, {
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
          headers: {
            "content-type": "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(request),
        });
      } catch (error) {
        if (error instanceof Error && error.name === "TimeoutError") {
          throw new AgentError(`agent did not answer within ${timeoutMs}ms`);
        }
        throw new AgentError(`cannot reach ${url}: ${String(error)}`);
      }

      if (!response.ok) {
        throw new AgentError(`${url} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new AgentError("agent returned invalid JSON");
      }
      return parseActions(body);
    },
  };
}

/** The configured agent, or undefined when AGENT_URL is blank (JOLO flow off). */
export const joloAgent: AgentClient | undefined = agentUrl
  ? httpAgent(agentUrl, agentToken, agentTimeoutMs)
  : undefined;
