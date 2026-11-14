// `npm run models` — lists the models the configured key can actually reach.
// Published model lists go stale; this asks the provider directly.
import { llmApiKey, llmBaseUrl } from "./env.ts";

const response = await fetch(`${llmBaseUrl}/models`, {
  headers: llmApiKey ? { authorization: `Bearer ${llmApiKey}` } : {},
});

if (!response.ok) {
  console.error(`${llmBaseUrl}/models returned ${response.status}`);
  console.error((await response.text()).slice(0, 400));
  process.exit(1);
}

const body = (await response.json()) as { data?: { id?: string }[] };
const ids = (body.data ?? []).map((m) => m.id).filter(Boolean).sort();

console.log(`${ids.length} models available at ${llmBaseUrl}:\n`);
for (const id of ids) console.log(`  ${id}`);
