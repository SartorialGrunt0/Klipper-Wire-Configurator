"""API routes for the embedded user manual."""
from __future__ import annotations

import os
import re
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import HTMLResponse, FileResponse

import markdown as md_lib

router = APIRouter()

# Manual directory (relative to this file)
MANUAL_DIR = Path(__file__).parent.parent.parent / "reference" / "manual"
FIGURES_DIR = MANUAL_DIR / "figures"


def _validate_section_name(section: str) -> str:
    """Validate section name (prevent path traversal)."""
    safe_name = re.sub(r'[^a-z0-9-]', '', section)
    if not safe_name:
        raise HTTPException(400, "Invalid section name")
    return safe_name


def _rewrite_assets(content: str) -> str:
    """Rewrite relative links so they resolve against the backend API.

    - `![..](./figures/x.png)` → `![..](/api/manual/figures/x.png)`
    - `[Link](./02-graph-ui.md)` → `[Link](/api/manual/02-graph-ui)`
    """
    content = content.replace('](./figures/', '](/api/manual/figures/')
    # Cross-section links (./02-graph-ui.md or 02-graph-ui.md) → absolute
    # backend route. Absolute paths resolve correctly in the in-app dialog
    # (SPA root + Vite proxy), on pop-out HTML pages, and in production.
    content = re.sub(
        r'\]\((?:\.?/)?(\d{2}-[a-z0-9-]+)\.md\)',
        r'](/api/manual/\1)',
        content,
    )
    return content


def _section_html(content: str, title: str) -> HTMLResponse:
    body = md_lib.markdown(_rewrite_assets(content), extensions=['tables', 'fenced_code'])
    return HTMLResponse(f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title} — KWC User Manual</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{
    margin: 0; padding: 2rem 1rem; background: #0d1421; color: #dbe2ee;
    font: 14px/1.6 -apple-system, 'Segoe UI', Roboto, sans-serif;
  }}
  main {{ max-width: 46rem; margin: 0 auto; }}
  h1 {{ font-size: 1.5rem; margin-bottom: 1rem; }}
  h2 {{ font-size: 1.15rem; margin-top: 2rem; padding-bottom: .25rem; border-bottom: 1px solid #263143; }}
  h3 {{ font-size: 1rem; margin-top: 1.5rem; }}
  code {{ background: #1a2332; border-radius: 4px; padding: .1rem .3rem; font-size: .9em; }}
  pre {{ background: #111a29; border: 1px solid #263143; border-radius: 8px; padding: .75rem; overflow-x: auto; }}
  pre code {{ background: none; padding: 0; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; font-size: .9em; }}
  th, td {{ border: 1px solid #263143; padding: .4rem .6rem; text-align: left; }}
  th {{ background: #1a2332; }}
  img {{ max-width: 100%; border-radius: 8px; border: 1px solid #263143; }}
  figure {{ margin: 1.25rem 0; }}
  figcaption {{ font-size: .85rem; color: #8b98ab; margin-top: .5rem; }}
  blockquote {{ border-left: 3px solid #263143; margin: 1rem 0; padding: .25rem 1rem; color: #8b98ab; }}
  a {{ color: #5aa2ff; }}
</style>
</head>
<body><main>{body}</main></body>
</html>""")


@router.get("/manual")
async def get_manual_section(section: str | None = None):
    """Serve manual markdown content.
    
    - No section param: Return list of available sections
    - ?section=01-getting-started: Return markdown content for that section
    """
    if not MANUAL_DIR.exists():
        raise HTTPException(500, "Manual directory not found")
    
    if not section:
        # Return list of available sections (sorted by filename)
        try:
            files = sorted([
                f[:-3] for f in os.listdir(MANUAL_DIR)
                if f.endswith('.md') and f[0].isdigit() and f != 'index.md'
            ])
            return {"sections": files, "count": len(files)}
        except Exception as e:
            raise HTTPException(500, f"Could not read manual directory: {e}")
    
    safe_name = _validate_section_name(section)
    path = MANUAL_DIR / f"{safe_name}.md"
    
    if not path.exists():
        raise HTTPException(404, f"Section '{section}' not found")
    
    try:
        with open(path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        return {
            "content": _rewrite_assets(content),
            "section": safe_name,
            "title": safe_name.replace('-', ' ').title()
        }
    except Exception as e:
        raise HTTPException(500, f"Could not read manual section: {e}")


@router.get("/manual/figures/{filename}")
async def get_manual_figure(filename: str):
    """Serve figure images (PNG/SVG) referenced by the manual content."""
    safe_name = re.sub(r'[^a-zA-Z0-9._-]', '', filename)
    if safe_name in ('', '.', '..') or '/' in filename or '\\' in filename:
        raise HTTPException(400, "Invalid filename")
    path = FIGURES_DIR / safe_name
    if not path.is_file():
        raise HTTPException(404, f"Figure '{filename}' not found")
    if safe_name.endswith('.svg'):
        return HTMLResponse(path.read_bytes(), media_type='image/svg+xml')
    return FileResponse(path)


@router.get("/manual/{section}", response_class=HTMLResponse)
async def get_manual_section_html(section: str):
    """Serve a section as a standalone HTML page (used by the Pop-out button)."""
    safe_name = _validate_section_name(section)
    path = MANUAL_DIR / f"{safe_name}.md"
    if not path.exists():
        raise HTTPException(404, f"Section '{section}' not found")
    content = path.read_text(encoding='utf-8')
    return _section_html(content, safe_name.replace('-', ' ').title())
