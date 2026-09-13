import urllib.request, json

LAN = "192.168.1.135"
url = f"http://{LAN}:8080/v1/chat/completions"

def try_req(payload, label):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = json.loads(r.read().decode())
            print(label, "OK:", body.get("choices", [{}])[0].get("message", {}).get("content", "")[:120])
    except urllib.error.HTTPError as e:
        print(label, "HTTP", e.code, e.read()[:600].decode(errors="replace"))
    except Exception as e:
        print(label, "ERR", repr(e))

# 1. minimal, no extras
try_req({"model": "gemma-4-12b", "messages": [{"role": "user", "content": "Say OK"}],
         "max_tokens": 16}, "minimal")

# 2. with harness-like params (temperature, text tool protocol simulation)
try_req({"model": "gemma-4-12b",
         "messages": [{"role": "system", "content": "You are a helpful assistant."},
                      {"role": "user", "content": "Say OK"}],
         "max_tokens": 64, "temperature": 0.7}, "sys+user temp")

# 3. with tools array (what harness text protocol may still send)
try_req({"model": "gemma-4-12b",
         "messages": [{"role": "user", "content": "Say OK"}],
         "max_tokens": 64,
         "tools": [{"type": "function", "function": {"name": "noop", "description": "noop", "parameters": {"type": "object", "properties": {}}}}]},
        "with tools")
