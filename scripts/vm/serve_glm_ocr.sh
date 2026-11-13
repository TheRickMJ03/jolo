#!/usr/bin/env bash
# Serve GLM-OCR on the VM: photo in, transcribed text out.
# Run it inside tmux on the VM:   bash scripts/vm/serve_glm_ocr.sh
# Stop it with Ctrl+C.
#
# The first run downloads the model weights (roughly 2 GB) to ~/.cache/huggingface.
#
# It uses port 8001, the same as serve_qwen.sh, so only one of the two can run
# at a time. That is fine for evaluation: transcribe every photo first (the
# replies are cached), stop this server, then start Qwen.
#
# Flags:
#   --speculative-config           from GLM-OCR's README (faster decoding)
#   --served-model-name glm-ocr    the name the "vm" profile in config.yaml asks for
#   --gpu-memory-utilization 0.5   the model is small; no need to take the whole GPU
set -euo pipefail

source ~/vllm-env/bin/activate

vllm serve zai-org/GLM-OCR \
  --port 8000 \
  --served-model-name glm-ocr \
  --max-model-len 16384 \
  --max-num-seqs 4 \
  --gpu-memory-utilization 0.5 2>&1 | tee ~/glm.log
