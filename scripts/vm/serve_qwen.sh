#!/usr/bin/env bash
# Serve Qwen3.5-9B on the VM as the "structurer": text in, menu JSON out.
# Run it inside tmux on the VM:   bash scripts/vm/serve_qwen.sh
# Stop it with Ctrl+C.
#
# The first run downloads the model weights (roughly 20 GB) to ~/.cache/huggingface.
#
# Flags:
#   --language-model-only          text only: skips the vision encoder to save GPU memory
#   --reasoning-parser qwen3       from the Qwen3.5 vLLM recipe
#   --default-chat-template-kwargs turns thinking mode OFF for every request
#   --max-model-len 16384          enough for a transcript plus a full menu as JSON,
#                                  and small enough to fit the L4's 24 GB
set -euo pipefail

source ~/vllm-env/bin/activate

vllm serve RedHatAI/Qwen3.5-9B-FP8-dynamic \
  --port 8000 \
  --served-model-name qwen3.5-9b \
  --language-model-only \
  --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  --max-model-len 16384 \
  --max-num-seqs 4 \
  --max-num-batched-tokens 4096 \
  --gpu-memory-utilization 0.90
