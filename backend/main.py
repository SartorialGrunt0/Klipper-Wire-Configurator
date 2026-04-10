"""Klipper Wire Configurator - Backend Application"""
import os
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("KWC_PORT", "8099"))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=True)
