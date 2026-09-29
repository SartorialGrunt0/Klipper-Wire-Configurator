#!/bin/bash
# Bank-106 multi-model driver — run serially through the single local backend.
# Leg 1: refresh documented models (CachyPC 192.168.1.135:8080)
# Leg 2: new models (Thor 192.168.1.34:8080)
cd /home/clifgall/Klipper-Wire-Configurator || exit 1
SERIES=reports/ai-chat-accuracy/bank106-r1-series.log
CACHY=http://192.168.1.135:8080/v1/chat/completions
THOR=http://192.168.1.34:8080/v1/chat/completions

probe() { curl -s --max-time 12 "$1" -o /dev/null -w '%{http_code}'; }

run() {
  local name="$1" url="$2" model="$3" label="$4"
  local models_url="${url%/chat/completions}/models"
  local code; code=$(probe "$models_url")
  if [ "$code" != "200" ]; then
    echo "=== $name ($model) SKIPPED endpoint probe=$code $(date +%H:%M:%S)" >> "$SERIES"
    return
  fi
  mkdir -p "reports/ai-chat-accuracy/$name"
  echo "=== $name ($model) [$label] START $(date +%H:%M:%S)" >> "$SERIES"
  python3 scripts/ai_chat_accuracy_test.py \
    --provider openai-compatible --api-url "$url" \
    --model "$model" --max-tokens 8192 --temperature 0.7 \
    --tool-protocol native --edit-tools on \
    --base-url http://localhost:8099 \
    --output-dir "reports/ai-chat-accuracy/$name" \
    > "reports/ai-chat-accuracy/$name/run.log" 2>&1
  echo "=== $name EXIT=$? DONE $(date +%H:%M:%S)" >> "$SERIES"
}

# Leg 1 — documented models (CachyPC)
run bank106-r1-cachypc-gemma-4-12b  "$CACHY" gemma-4-12b  documented
run bank106-r1-cachypc-qwen3.5-4b   "$CACHY" qwen3.5-4b   documented
run bank106-r1-cachypc-gemma-4-e4b  "$CACHY" gemma-4-e4b  documented
run bank106-r1-cachypc-qwen3.5-9b   "$CACHY" qwen3.5-9b   documented

# Leg 2 — new models (Thor)
run bank106-r1-thor-qwen3.6-35b-a3b "$THOR" qwen/Qwen3.6-35B-A3B      new
run bank106-r1-thor-qwen3.8-27b     "$THOR" qwen/Qwen3.8-27B          new
run bank106-r1-thor-gemma-4-26b-a4b "$THOR" google/gemma-4-26B-A4B    new

echo "=== ALL BANK106 R1 RUNS COMPLETE $(date +%H:%M:%S)" >> "$SERIES"
