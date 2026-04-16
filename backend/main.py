"""Klipper Wire Configurator - Backend Application"""
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from api.routes import router

app = FastAPI(title="Klipper Wire Configurator", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router, prefix="/api")

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
