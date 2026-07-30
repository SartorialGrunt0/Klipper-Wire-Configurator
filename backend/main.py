"""Klipper Wire Configurator - Backend Application"""
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api.routes import router
from api.native_routes import router as native_router
from api.ai_routes import router as ai_router
from api.printer_memory_routes import router as printer_memory_router
from mcp_server import McpServer, get_index
from fastapi.responses import JSONResponse

app = FastAPI(title="Klipper Wire Configurator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Shared MCP server instance (embedded, zero extra RAM) ──
mcp_server = McpServer()


@app.post("/api/mcp")
async def mcp_endpoint(request: dict):
    """MCP JSON-RPC endpoint for the /ai/chat proxy and external HTTP clients.

    Allows the AI chat proxy to call MCP tools without spawning a subprocess.
    External MCP clients that support HTTP transport (e.g. pi, some VS Code
    extensions) can also connect here.

    For stdio-based MCP clients (Claude Desktop, etc.):
        python -m backend.mcp_server
    """
    result = mcp_server.handle_jsonrpc(request)
    if result is None:
        return JSONResponse(content={}, status_code=202)
    return result


@app.get("/api/mcp/health")
async def mcp_health():
    """MCP server health check — returns index stats."""
    index = get_index()
    return {
        "status": "ok",
        "documents_indexed": index.get_doc_count(),
        "server": "klipper-wire-configurator",
        "protocol": "2024-11-05",
    }


app.include_router(router, prefix="/api")
app.include_router(native_router, prefix="/api/native")
app.include_router(ai_router)
app.include_router(printer_memory_router, prefix="/api")

PROJECTS_DIR = Path(os.environ.get("KWC_PROJECTS_DIR", "./projects"))
PROJECTS_DIR.mkdir(parents=True, exist_ok=True)

REFERENCE_DIR = Path(__file__).parent.parent / "reference"

# Serve built frontend in production
FRONTEND_DIST = Path(__file__).parent.parent / "frontend" / "dist"


@app.get("/health")
async def health():
    return {"status": "ok"}


if FRONTEND_DIST.is_dir():
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        """Serve the SPA index.html for all non-API routes."""
        file_path = FRONTEND_DIST / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(FRONTEND_DIST / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("KWC_PORT", "8099"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
