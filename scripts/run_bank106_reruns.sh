#!/bin/bash
# Re-run qids lost to infra errors (provider 500 bursts / timeouts) in bank106-r1.
# Cheap subset only — the 27B's 12 timeouts are a separate decision.
cd /home/clifgall/Klipper-Wire-Configurator || exit 1
SERIES=reports/ai-chat-accuracy/bank106-r1-rerun-series.log
CACHY=http://192.168.1.135:8080/v1/chat/completions
THOR=http://192.168.1.34:8080/v1/chat/completions

rerun() {
  local name="$1" url="$2" model="$3" qs="$4"
  mkdir -p "reports/ai-chat-accuracy/$name"
  echo "=== $name ($model) [$qs] START $(date +%H:%M:%S)" >> "$SERIES"
  python3 scripts/ai_chat_accuracy_test.py \
    --provider openai-compatible --api-url "$url" \
    --model "$model" --max-tokens 8192 --temperature 0.7 \
    --tool-protocol native --edit-tools on \
    --base-url http://localhost:8099 \
    --questions "$qs" \
    --output-dir "reports/ai-chat-accuracy/$name" \
    > "reports/ai-chat-accuracy/$name/run.log" 2>&1
  echo "=== $name EXIT=$? DONE $(date +%H:%M:%S)" >> "$SERIES"
}

rerun bank106-r1-rerun-qwen3.5-4b    "$CACHY" qwen3.5-4b              "Q17,Q18,Q19"
rerun bank106-r1-rerun-gemma-4-e4b   "$CACHY" gemma-4-e4b             "Q01,Q02"
rerun bank106-r1-rerun-gemma-4-26b   "$THOR"  "google/gemma-4-26B-A4B" "AMBI-02"
echo "=== ALL RERUNS COMPLETE $(date +%H:%M:%S)" >> "$SERIES"
