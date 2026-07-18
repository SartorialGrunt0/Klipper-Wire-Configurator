#!/usr/bin/env python3
"""
MCP stdio wrapper for Klipper-Wire-Configurator.

External MCP clients (Claude Desktop, pi, VS Code, Cursor, etc.) 
configure this as a stdio subprocess to access Klipper documentation 
and config tools.

Usage:
    python mcp_wrapper.py

Claude Desktop config (~/Library/Application Support/Claude/claude_desktop_config.json):
{
  "mcpServers": {
    "kwc-klipper-tools": {
      "command": "python",
      "args": ["/path/to/backend/mcp_wrapper.py"]
    }
  }
}
"""

import sys
import os

# Add the backend directory to the Python path
backend_dir = os.path.dirname(os.path.abspath(__file__))
if backend_dir not in sys.path:
    sys.path.insert(0, backend_dir)

from mcp_server import run_stdio

if __name__ == "__main__":
    run_stdio()
