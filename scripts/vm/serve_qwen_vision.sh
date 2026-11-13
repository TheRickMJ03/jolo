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
set -euo pipefail

source ~/vllm-env/bin/activate

vllm serve RedHatAI/Qwen3.5-9B-FP8-dynamic \
  --port 8000 \
  --served-model-name qwen3.5-9b \
  --reasoning-parser qwen3 \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  --max-model-len 16384 \
  --max-num-seqs 4 \
  --gpu-memory-utilization 0.90
