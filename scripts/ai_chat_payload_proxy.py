#!/usr/bin/env python3
"""Payload-capture proxy for cache-hit forensics (companion to
scripts/ai_chat_cache_probe.py; plan .hermes/plans/2026-11-20_ai-chat-cache-hit-miss.md).

Passthrough HTTP proxy: KWC backend -> here -> inference router. Records
every /chat/completions REQUEST body, verbatim, to a JSONL file (one line
per provider call, in order) and streams responses back untouched (SSE
included). Consecutive lines are the ground truth for byte-level prefix
diffs across turns — the arbiter whenever a cached_tokens number needs a
mechanism story (probe gives the WHAT, this gives the WHERE).

Usage:
  backend/.venv-test/bin/python scripts/ai_chat_payload_proxy.py \
      /tmp/payload-capture.jsonl [port] [--target http://192.168.1.34:8080]

Then point the probe (or the app's AI settings apiUrl) at
http://127.0.0.1:<port>/v1 and analyze:

  lines = [json.loads(l) for l in open(capture)]
  # render each payload as role-delimited text, LCP-diff consecutive
  # entries; the divergence offset names the block that moved.

Stdlib-only, bind to localhost, stop it when done (it logs full request
bodies incl. config text — treat the capture file as config-equivalent).
"""
import argparse
import http.server
import json
import sys
import urllib.error
import urllib.request

PARSER = argparse.ArgumentParser(description=__doc__)
PARSER.add_argument("capture", help="JSONL file to append provider requests to")
PARSER.add_argument("port", nargs="?", type=int, default=18080)
PARSER.add_argument("--target", default="http://192.168.1.34:8080",
                    help="upstream inference server base URL")
ARGS = PARSER.parse_args()

_capture_state = {"failed": False}


def _capture_write(record) -> None:
    """Append one JSONL row. A logging proxy must never break the chat it
    observes — but a SILENTLY empty capture is worse: an LCP diff over a
    truncated capture reads as 'no prefix divergence', a green that cannot
    fail. The first write error warns on stderr and disables capture."""
    if _capture_state["failed"]:
        return
    try:
        with open(ARGS.capture, "a") as fh:
            fh.write(json.dumps(record) + "\n")
    except (ValueError, OSError) as exc:
        _capture_state["failed"] = True
        print(f"[proxy] capture DISABLED, cannot write {ARGS.capture}: {exc}",
              file=sys.stderr)


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _forward(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        req = urllib.request.Request(
            ARGS.target + self.path, data=body, method=self.command,
            headers={k: v for k, v in self.headers.items()
                     if k.lower() not in ("host", "content-length")})
        try:
            upstream = urllib.request.urlopen(req, timeout=600)
        except urllib.error.HTTPError as err:
            self.send_response(err.code)
            payload = err.read()
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if "/chat/completions" in self.path and body:
            try:
                record = json.loads(body)
            except ValueError:
                record = None  # unparseable body: nothing to record
            if record is not None:
                _capture_write(record)
        ctype = upstream.headers.get("Content-Type", "application/json")
        self.send_response(upstream.status)
        self.send_header("Content-Type", ctype)
        if "text/event-stream" not in ctype:
            data = upstream.read()
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            # Response-side telemetry: the provider's own cache numbers, so a
            # backend that predates C3 (main) can still be measured. Written as
            # a separate JSONL record so request bodies stay diff-able.
            if "/chat/completions" in self.path:
                try:
                    resp = json.loads(data)
                except ValueError:
                    resp = None
                if isinstance(resp, dict) and "usage" in resp:
                    u = resp.get("usage") or {}
                    t = resp.get("timings") or {}
                    _capture_write({"_usage": {
                        "prompt_tokens": u.get("prompt_tokens"),
                        "cached_tokens": (u.get("prompt_tokens_details") or {}).get("cached_tokens"),
                        "prompt_ms": t.get("prompt_ms"),
                        "predicted_ms": t.get("predicted_ms"),
                    }})
        else:
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = upstream.read(4096)
                if not chunk:
                    break
                self.wfile.write(b"%X\r\n%s\r\n" % (len(chunk), chunk))
            self.wfile.write(b"0\r\n\r\n")
        upstream.close()

    do_POST = _forward
    do_GET = _forward

    def log_message(self, format, *args):  # noqa: A002 - match base signature
        pass


http.server.ThreadingHTTPServer(("127.0.0.1", ARGS.port), Handler).serve_forever()
