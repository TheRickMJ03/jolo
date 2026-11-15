# Running the brain on the VM

Today the brain runs on a laptop with an SSH tunnel to the VM. That works for a demo, and it needs the laptop, the tunnel and the VM all up. The better setup runs the brain on the VM next to vLLM: no tunnel, and with Firestore as the store the brain keeps almost no state.

```
iPhone ─ iMessage ─▶ bridge (Isaiah's Mac) ──HTTPS/HTTP + Bearer token──▶ VM:8080  brain  ──▶ localhost:8000  vLLM (Qwen)
                                                                                      └────▶ Firestore (jolo-ec76d)
```

Nothing here has been run on the VM yet. Files: [`deploy/`](../deploy), [`scripts/serve_brain.py`](../scripts/serve_brain.py), [`scripts/healthcheck.py`](../scripts/healthcheck.py).

## Steps

1. **Code and dependencies** on the VM, in the repo root:
   ```bash
   python -m venv .venv && source .venv/bin/activate
   pip install -r requirements.txt && pip install -r requirements-agent.txt -c requirements.txt
   ```
   The VM has a GPU, so install the normal `torch` there, not the CPU build, and set `agent.search.device: cuda` in `config.yaml`.
2. **Secrets** in `.env` (copy [`deploy/env.example`](../deploy/env.example)): `AGENT_TOKEN`, `JOLO_PHONE_SALT`, and `GOOGLE_APPLICATION_CREDENTIALS` pointing at the service-account key file. The key and `.env` never go in Git. Put the same `AGENT_TOKEN` in the bridge's `.env`.
3. **Config:** `agent.store.backend: firestore`, `agent.api.host: 0.0.0.0`. The model endpoint is `localhost:8000`, so the tunnel isn't needed. `scripts/serve_brain.py` refuses to listen on the network without `AGENT_TOKEN` or `JOLO_API_KEY`.
4. **Model server** (as before): `bash scripts/vm/serve_qwen_vision.sh` in tmux, or as its own systemd unit.
5. **Build the index once:** `python scripts/build_index.py`. After that the brain rebuilds it at startup and re-indexes menus the app edits (every `search.refresh_seconds`).
6. **Brain as a service:** [`deploy/jolo-brain.service`](../deploy/jolo-brain.service). Edit `User` and the paths, then:
   ```bash
   sudo cp deploy/jolo-brain.service /etc/systemd/system/ && sudo systemctl daemon-reload
   sudo systemctl enable --now jolo-brain
   journalctl -u jolo-brain -f
   ```
7. **Firewall:** open port 8080 in the instance's security group **only to the bridge's address**. Port 8000 (vLLM) stays closed to everyone; the brain reaches it on localhost.
8. **Weekly insights:** [`deploy/jolo-insights.timer`](../deploy/jolo-insights.timer) runs `scripts/weekly_insights.py` on Mondays at 06:15 in the VM's time zone. Run it once by hand first: `python scripts/weekly_insights.py --dry-run`.
9. **Monitoring:** [`deploy/jolo-health.timer`](../deploy/jolo-health.timer) runs `scripts/healthcheck.py` every 5 minutes; a failure shows in `systemctl --failed`. The same script works from any uptime monitor: it exits 1 when the API doesn't answer, the model server is down, or the store is empty.

## The first deploy against the real Firestore

- Use a **service-account key from Isaiah** for `jolo-ec76d`. Until then, run against the emulator: `FIRESTORE_EMULATOR_HOST=localhost:8080` (the app's `npm run emulators`).
- **Do not run `scripts/seed_store.py` against the real project.** It writes 22 invented cafés; the script refuses unless you pass `--really-write-to-firestore`.
- To make a phone the owner of a café, set that café's `ownerPhone` (E.164, e.g. `+19085551234`). The bridge's onboarding already does this for new cafés.
- The brain's own data goes to `agentUsers`, `agentDrafts`, `agentEvents` and `agentCorrections`. `jolo-app/firestore.rules` denies those to every client, so only the Admin SDK reads them.

## Secrets checklist

| Secret | Where | Notes |
|---|---|---|
| `AGENT_TOKEN` | brain `.env` and bridge `.env` | Same value on both. |
| `JOLO_PHONE_SALT` | brain `.env` only | Never change it after the first real user. |
| Service-account key | a file on the VM, path in `.env` | Not in Git, not in chat. |
| `JOLO_API_KEY` | optional | For callers other than the bridge. |

## Limits worth knowing

- One brain process per Firestore project. Drafts live in Firestore, but a menu read runs in a thread of the process that received the photo: restarting it during a read loses that read. At startup the brain drops such drafts, so the owner just sends the photo again.
- Rate limits are in memory, per process: 30 messages a minute and 12 photos an hour per sender, set in `config.yaml` (`agent.api.rate_limit_*`).
- Logs mask phone numbers and emails.
