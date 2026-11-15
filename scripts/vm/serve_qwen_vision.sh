#!/usr/bin/env bash
# The JOLO menu reader's model server: Qwen3.5-9B with vision, on the VM.
# This is the exact setup the dev results were measured with.
#
# Run it inside tmux on the VM:   bash scripts/vm/serve_qwen_vision.sh
# Ready when it prints "Application startup complete". Stop it with Ctrl+C.
# The VM costs about $1/hour while it runs: stop the instance when you're done.
#
# The first run downloads the model weights to ~/.cache/huggingface.
#
# Flags:
#   RedHatAI/Qwen3.5-9B-FP8-dynamic  the 8-bit build, the one that ran on the L4 (24 GB)
#   --served-model-name qwen3.5-9b   the name config.yaml asks for
#   --reasoning-parser qwen3         from the Qwen3.5 vLLM recipe
#   --default-chat-template-kwargs   turns thinking mode OFF for every request
#   --max-model-len 16384            a photo plus a full menu fits; without it the
#                                    server asks for the full 262,144 and fails to start
#   (no --language-model-only)       that flag would switch off the vision part
#
# Optional, for the agent's native tool calling (config.yaml agent.tool_mode: native):
#   TOOL_PARSER=hermes bash scripts/vm/serve_qwen_vision.sh
# adds --enable-auto-tool-choice --tool-call-parser hermes. Without it nothing changes, and the
# agent uses its JSON mode. Compare parsers with agent_eval/run_conversations.py (see docs/brain.md).
set -euo pipefail

source ~/vllm-env/bin/activate

TOOL_FLAGS=()
if [ -n "${TOOL_PARSER:-}" ]; then
  TOOL_FLAGS=(--enable-auto-tool-choice --tool-call-parser "$TOOL_PARSER")
fi

vllm serve RedHatAI/Qwen3.5-9B-FP8-dynamic \
  --port 8000 \
  --served-model-name qwen3.5-9b \
  --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  --max-model-len 16384 \
  --max-num-seqs 4 \
  --gpu-memory-utilization 0.90 \
  ${TOOL_FLAGS[@]+"${TOOL_FLAGS[@]}"}
