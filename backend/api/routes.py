"""API routes for Klipper Wire Configurator."""
from __future__ import annotations

import json
from pathlib import Path
from typing import List

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

from models.config_models import (
    BulkWarningAcknowledgementRequest,
    ConfigUpdate,
    ExportRequest,
    GenerateRequest,
    ParamUpdate,
    ProjectValidationRequest,
    ProjectSave,
    SectionUpdate,
    WarningAcknowledgementRequest,
)
from parser.config_parser import (
    ConfigFile,
    ConfigParam,
    ConfigSection,
    parse_config,
)
from parser.config_schema import (
    SECTION_DEFS,
    ParamType,
    get_all_section_types,
    get_section_def,
    get_sections_by_category,
    get_sections_by_group,
)
from parser.config_writer import write_config, smart_export
from parser.validator import validate_config, validate_project_configs
from services.board_detector import (
    BOARD_TYPE_DIRS,
    detect_board_from_config,
    fuzzy_match_examples,
    get_available_examples,
)
from services.warning_acknowledgments import (
    acknowledge_duplicate_section_type,
    acknowledge_warning_for_section,
    acknowledge_warning_identities,
    finding_identity,
)

router = APIRouter()

# Hard-failover doc/config sources (installed Klipper repo when present,
# bundled copies otherwise) — shared with the MCP docs tools.
from klipper_paths import CONFIG_EXAMPLES_DIR, KLIPPER_DOCS_DIR, REFERENCE_DIR  # noqa: E402

PROJECTS_DIR = Path(__file__).parent.parent / "projects"

# Local storage dir for browser-mode saves (non-native Save).
# Import never writes to disk — only the Save/Apply flow persists files —
# so this is deliberately KWC's own store, never the system config path.
CONFIG_STORAGE_DIR = Path(__file__).parent.parent / "user_configs"


def _resolve_config_path(filename: str) -> Path | None:
    """Find a config file by name, searching type subdirectories first."""
    config_dir = CONFIG_EXAMPLES_DIR
    # Check subdirectories
    for subdir in BOARD_TYPE_DIRS:
        candidate = config_dir / subdir / filename
        if candidate.exists():
            return candidate
    # Fall back to flat root
    candidate = config_dir / filename
    if candidate.exists():
        return candidate
    return None


def _resolve_klipper_doc_path(filename: str) -> Path:
    if Path(filename).name != filename or not filename.endswith(".md"):
        raise HTTPException(status_code=400, detail="Invalid doc filename")

    doc_path = KLIPPER_DOCS_DIR / filename
    if not doc_path.exists() or not doc_path.is_file():
        raise HTTPException(status_code=404, detail=f"{filename} not found")

    return doc_path


# ── Import / Parse ──────────────────────────────────────────────


def _save_config_file(filename: str, text: str) -> None:
    """Persist a config file to the local config storage directory.

    Used by browser-mode Save (/configs/save) only. Import never writes to
    disk — the Save/Apply flow is the only thing that persists files.
    Creates the directory if it doesn't exist. Uses binary mode to preserve
    exact original line endings.
    """
    try:
        CONFIG_STORAGE_DIR.mkdir(parents=True, exist_ok=True)
        dest = CONFIG_STORAGE_DIR / filename
        dest.write_bytes(text.encode("utf-8"))
    except OSError:
        pass  # Non-critical — import parsing still succeeds


@router.post("/import")
async def import_config(file: UploadFile = File(...)):
    """Import and parse a .cfg file."""
    content = await file.read()
    text = content.decode("utf-8", errors="replace")
    # Strip any path prefix the browser may include (e.g. "config/printer.cfg" → "printer.cfg")
    filename = Path(file.filename or "printer.cfg").name or "printer.cfg"

    config = parse_config(text, filename)
    validation = validate_config(config)
    board_info = detect_board_from_config(config)

    return {
        "config": config.to_dict(),
        "validation": validation.to_dict(),
        "board_info": board_info,
    }


@router.post("/import-project")
async def import_project(files: List[UploadFile] = File(...)):
    """Import multiple .cfg files as a project.

    Parses all files, detects the main config (printer.cfg or the file
    with the most [include] directives), and returns per-file results
    plus a project-level summary of MCUs found and include relationships.
    """
    configs = {}
    board_infos = {}

    for f in files:
        content = await f.read()
        text = content.decode("utf-8", errors="replace")
        # Strip any path prefix the browser may include (e.g. "config/printer.cfg" → "printer.cfg")
        filename = Path(f.filename or "unknown.cfg").name or "unknown.cfg"

        # Only process .cfg files
        if not filename.endswith(".cfg"):
            continue

        config = parse_config(text, filename)
        configs[filename] = config
        board_infos[filename] = detect_board_from_config(config)

    if not configs:
        raise HTTPException(status_code=400, detail="No .cfg files found in upload")

    validations = validate_project_configs(configs)
    results = {
        filename: {
            "config": config.to_dict(),
            "validation": validations[filename].to_dict(),
            "board_info": board_infos[filename],
        }
        for filename, config in configs.items()
    }

    # Detect main file
    main_file = "printer.cfg" if "printer.cfg" in configs else None
    if not main_file:
        # Pick file with most includes
        main_file = max(configs.keys(), key=lambda fn: len(configs[fn].includes))

    # Discover all MCUs across files
    mcus = []
    for filename, config in configs.items():
        for sec in config.sections:
            if sec.section_type == "mcu":
                mcus.append({
                    "name": sec.section_name or "",
                    "file": filename,
                    "params": {p.key: p.value for p in sec.params if not p.is_commented_out},
                })

    # Map includes from main file to imported files
    resolved_includes = []
    if main_file and main_file in configs:
        for inc in configs[main_file].includes:
            inc_basename = inc.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
            matched = inc_basename in configs
            resolved_includes.append({
                "path": inc,
                "resolved": matched,
                "filename": inc_basename if matched else None,
            })

    return {
        "files": results,
        "project": {
            "main_file": main_file,
            "mcus": mcus,
            "includes": resolved_includes,
            "file_count": len(results),
        },
    }


@router.post("/parse")
async def parse_config_text(data: dict):
    """Parse config text directly."""
    text = data.get("text", "")
    filename = data.get("filename", "printer.cfg")
    config = parse_config(text, filename)
    validation = validate_config(config)
    return {
        "config": config.to_dict(),
        "validation": validation.to_dict(),
    }


# ── Validate ────────────────────────────────────────────────────


@router.post("/validate")
async def validate_config_api(data: ConfigUpdate):
    """Validate a configuration."""
    config = _config_update_to_config_file(data)
    validation = validate_config(config)
    return validation.to_dict()


@router.post("/validate-project")
async def validate_project_api(data: ProjectValidationRequest):
    """Validate a multi-file configuration project."""
    configs = {}
    for config_data in data.config_files:
        config = _config_update_to_config_file(config_data)
        if config_data.raw_text:
            config.raw_text = config_data.raw_text
        configs[config_data.filename] = config

    validations = validate_project_configs(configs)
    return {
        "files": {
            filename: validation.to_dict()
            for filename, validation in validations.items()
        }
    }


@router.post("/warning-acknowledgements")
async def acknowledge_warning_api(data: WarningAcknowledgementRequest):
    """Persist a section whose unknown-section warning has been acknowledged."""
    section = ConfigSection(
        section_type=data.section.section_type,
        section_name=data.section.section_name,
        full_header=data.section.full_header,
        line_number=data.section.line_number,
        params=[
            ConfigParam(
                key=param.key,
                value=param.value,
                comment=param.comment,
                is_commented_out=param.is_commented_out,
                separator=param.separator,
            )
            for param in data.section.params
        ],
        header_comments=data.section.header_comments,
        trailing_comments=data.section.trailing_comments,
        is_commented_out=data.section.is_commented_out,
    )
    file_path = acknowledge_warning_for_section(section)
    return {"status": "acknowledged", "file": file_path}


@router.post("/warning-acknowledgements/duplicate")
async def acknowledge_duplicate_api(data: WarningAcknowledgementRequest):
    """Persist acknowledgment of a duplicate-section warning for a section type.

    Duplicate-section warnings are per section *type* (a singleton section
    repeated in one file or across included files), so the ack is keyed by
    ``section_type`` and suppresses the warning for every occurrence.
    """
    file_path = acknowledge_duplicate_section_type(data.section.section_type)
    return {
        "status": "acknowledged",
        "file": file_path,
        "section_type": data.section.section_type,
    }


@router.post("/warning-acknowledgements/bulk")
async def acknowledge_bulk_warnings_api(
    data: BulkWarningAcknowledgementRequest,
):
    """Bulk-acknowledge warning findings by stable identity (Phase 4 save gate).

    Each identity is ``file|code|section|param|extra`` — ``extra`` is
    DERIVED SERVER-SIDE (the include spec for missing includes; empty
    otherwise) so suppression and the ack store always agree. Client
    ``extra`` is accepted for API symmetry but ignored. Warnings only: the
    validator never suppresses errors or info from this store. Idempotent;
    the frontend revalidates the project afterwards so the warning state
    clears.
    """
    if not data.identities:
        raise HTTPException(
            status_code=422, detail="No warning identities to acknowledge")
    identities = [
        finding_identity(item.file, item.code, item.section, item.param)
        for item in data.identities
    ]
    file_path = acknowledge_warning_identities(identities)
    return {
        "status": "acknowledged",
        "file": file_path,
        "count": len(identities),
    }


# ── Export ──────────────────────────────────────────────────────


@router.post("/export")
async def export_config(data: ConfigUpdate):
    """Export configuration to .cfg text."""
    config = _config_update_to_config_file(data)
    if data.raw_text:
        config.raw_text = data.raw_text
    text = smart_export(config)
    return PlainTextResponse(content=text, media_type="text/plain")


@router.post("/export-project")
async def export_project(data: ExportRequest):
    """Export a full project as multiple .cfg files."""
    files = {}
    for cfg_data in data.project.config_files:
        config = _config_update_to_config_file(cfg_data)
        if cfg_data.raw_text:
            config.raw_text = cfg_data.raw_text
        files[cfg_data.filename] = smart_export(config)
    return {"files": files}


# ── Generate ────────────────────────────────────────────────────


@router.post("/generate")
async def generate_config(data: GenerateRequest):
    """Generate a new config from a template or blank."""
    if data.template:
        # Load from example
        config_path = _resolve_config_path(data.template)
        if not config_path:
            raise HTTPException(status_code=404, detail=f"Template '{data.template}' not found")
        text = config_path.read_text(encoding="utf-8", errors="replace")
        config = parse_config(text, "printer.cfg")
    else:
        # Generate blank with selected kinematics
        config = _generate_blank_config(data.kinematics)

    validation = validate_config(config)
    return {
        "config": config.to_dict(),
        "validation": validation.to_dict(),
    }


# ── Examples ────────────────────────────────────────────────────


@router.get("/examples")
async def list_examples():
    """List all available example configurations."""
    examples = get_available_examples(REFERENCE_DIR)
    return {"examples": examples}


@router.get("/examples/search")
async def search_examples(q: str = ""):
    """Fuzzy search example configurations."""
    examples = get_available_examples(REFERENCE_DIR)
    if q:
        results = fuzzy_match_examples(q, examples)
    else:
        results = examples
    return {"results": results}


@router.get("/examples/{filename}")
async def get_example(filename: str):
    """Load a specific example config."""
    # Validate filename to prevent path traversal
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    config_path = _resolve_config_path(filename)
    if not config_path:
        raise HTTPException(status_code=404, detail="Example not found")
    text = config_path.read_text(encoding="utf-8", errors="replace")
    config = parse_config(text, filename)
    return {"config": config.to_dict(), "raw_text": text}


@router.get("/reference/config-reference")
async def get_config_reference():
    """Return the bundled Klipper Config_Reference.md document."""
    config_ref = KLIPPER_DOCS_DIR / "Config_Reference.md"
    if not config_ref.exists():
        raise HTTPException(status_code=404, detail="Config_Reference.md not found")
    return {"content": config_ref.read_text(encoding="utf-8", errors="replace")}


@router.get("/reference/klipper-docs/{filename}")
async def get_klipper_doc(filename: str):
    """Return a bundled Klipper markdown document by filename."""
    doc_path = _resolve_klipper_doc_path(filename)
    return {
        "filename": doc_path.name,
        "content": doc_path.read_text(encoding="utf-8", errors="replace"),
    }


# ── Schema ──────────────────────────────────────────────────────


@router.get("/schema")
async def get_schema():
    """Get all available section schemas for the UI."""
    schemas = {}
    for sec_type, sec_def in SECTION_DEFS.items():
        schemas[sec_type] = {
            "section_type": sec_def.section_type,
            "display_name": sec_def.display_name,
            "category": sec_def.category,
            "component_group": sec_def.component_group,
            "is_named": sec_def.is_named,
            "description": sec_def.description,
            "max_instances": sec_def.max_instances,
            "requires": sec_def.requires,
            "params": [
                {
                    "name": p.name,
                    "type": p.param_type.value,
                    "required": p.required,
                    "default": p.default,
                    "description": p.description,
                    "enum_values": p.enum_values,
                    "unit": p.unit,
                }
                for p in sec_def.params
            ],
        }
    return {"schemas": schemas}


@router.get("/schema/{section_type}")
async def get_section_schema(section_type: str):
    """Get schema for a specific section type."""
    sec_def = get_section_def(section_type)
    if not sec_def:
        raise HTTPException(status_code=404, detail=f"Unknown section type: {section_type}")
    return {
        "section_type": sec_def.section_type,
        "display_name": sec_def.display_name,
        "category": sec_def.category,
        "component_group": sec_def.component_group,
        "is_named": sec_def.is_named,
        "description": sec_def.description,
        "params": [
            {
                "name": p.name,
                "type": p.param_type.value,
                "required": p.required,
                "default": p.default,
                "description": p.description,
                "enum_values": p.enum_values,
                "unit": p.unit,
            }
            for p in sec_def.params
        ],
    }


# ── Projects ────────────────────────────────────────────────────


@router.post("/projects/save")
async def save_project(data: ProjectSave):
    """Save a project to disk."""
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    # Sanitize name
    safe_name = "".join(c for c in data.name if c.isalnum() or c in "-_ ")
    if not safe_name:
        raise HTTPException(status_code=400, detail="Invalid project name")

    project_dir = PROJECTS_DIR / safe_name
    project_dir.mkdir(parents=True, exist_ok=True)

    # Save config files
    for cfg in data.config_files:
        config = _config_update_to_config_file(cfg)
        text = write_config(config)
        (project_dir / cfg.filename).write_text(text, encoding="utf-8")

    # Save graph layout
    layout_data = data.graph_layout.model_dump()
    (project_dir / "layout.json").write_text(
        json.dumps(layout_data, indent=2), encoding="utf-8"
    )

    return {"status": "saved", "name": safe_name}


@router.get("/projects")
async def list_projects():
    """List saved projects."""
    PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    projects = []
    for d in PROJECTS_DIR.iterdir():
        if d.is_dir():
            cfg_files = list(d.glob("*.cfg"))
            projects.append({
                "name": d.name,
                "files": [f.name for f in cfg_files],
                "has_layout": (d / "layout.json").exists(),
            })
    return {"projects": projects}


@router.get("/projects/{name}")
async def load_project(name: str):
    """Load a saved project."""
    # Sanitize
    safe_name = "".join(c for c in name if c.isalnum() or c in "-_ ")
    project_dir = PROJECTS_DIR / safe_name
    if not project_dir.exists():
        raise HTTPException(status_code=404, detail="Project not found")

    configs = {}
    for cfg_file in project_dir.glob("*.cfg"):
        text = cfg_file.read_text(encoding="utf-8", errors="replace")
        config = parse_config(text, cfg_file.name)
        configs[cfg_file.name] = config.to_dict()

    layout = None
    layout_file = project_dir / "layout.json"
    if layout_file.exists():
        layout = json.loads(layout_file.read_text(encoding="utf-8"))

    return {
        "name": safe_name,
        "configs": configs,
        "layout": layout,
    }


@router.post("/configs/save")
async def save_configs(data: dict):
    """Save config files to the local config storage directory.

    Accepts a dict of filename → config text, persists each file to
    CONFIG_STORAGE_DIR. Used by non-native mode to persist changes
    made after import. Accepts an optional ``deleted`` list of
    filenames to remove from storage (a file deleted from the model).
    """
    files: dict[str, str] = data.get("files", {})
    deleted: list[str] = data.get("deleted", []) or []
    if not files and not deleted:
        raise HTTPException(status_code=400, detail="No files provided")

    saved = []
    errors = []
    for filename, text in files.items():
        # Validate filename (no path traversal)
        if ".." in filename or filename.startswith("/") or filename.startswith("\\\\"):
            errors.append(f"Invalid filename: {filename}")
            continue
        try:
            _save_config_file(filename, text)
            saved.append(filename)
        except OSError as e:
            errors.append(f"{filename}: {e}")

    removed = []
    for filename in deleted:
        if ".." in filename or filename.startswith("/") or filename.startswith("\\\\"):
            errors.append(f"Invalid filename: {filename}")
            continue
        target = CONFIG_STORAGE_DIR / filename
        try:
            if target.is_file():
                target.unlink()
                removed.append(filename)
        except OSError as e:
            errors.append(f"{filename}: {e}")

    result: dict[str, object] = {"saved": saved, "removed": removed, "file_count": len(saved)}
    if errors:
        result["errors"] = errors
        if not saved and not removed:
            raise HTTPException(status_code=500, detail="Failed to save files: " + "; ".join(errors))
    return result


@router.get("/project/load-saved")
async def load_saved_configs():
    """Load all config files previously saved to CONFIG_STORAGE_DIR.

    Re-parses and re-validates each .cfg file found there, returning
    results in the same format as /import-project so the frontend can
    restore them on startup.
    """
    if not CONFIG_STORAGE_DIR.is_dir():
        return {"files": {}, "main_file": None, "mcus": [], "includes": [], "file_count": 0}

    configs = {}
    board_infos = {}
    filenames: list[str] = []

    try:
        for cfg_file in sorted(CONFIG_STORAGE_DIR.glob("*.cfg")):
            # Read in binary mode to preserve exact original content
            text = cfg_file.read_bytes().decode("utf-8", errors="replace")
            config = parse_config(text, cfg_file.name)
            configs[cfg_file.name] = config
            board_infos[cfg_file.name] = detect_board_from_config(config)
            filenames.append(cfg_file.name)
    except OSError:
        return {"files": {}, "main_file": None, "mcus": [], "includes": [], "file_count": 0}

    if not configs:
        return {"files": {}, "main_file": None, "mcus": [], "includes": [], "file_count": 0}

    validations = validate_project_configs(configs)

    results = {
        filename: {
            "config": config.to_dict(),
            "validation": validations[filename].to_dict(),
            "board_info": board_infos[filename],
        }
        for filename, config in configs.items()
    }

    # Detect main file
    main_file = "printer.cfg" if "printer.cfg" in configs else filenames[0]

    # Discover MCUs
    mcus = []
    for filename, config in configs.items():
        for sec in config.sections:
            if sec.section_type == "mcu":
                mcus.append({
                    "name": sec.section_name or "",
                    "file": filename,
                    "params": {p.key: p.value for p in sec.params if not p.is_commented_out},
                })

    # Resolve includes
    resolved_includes = []
    if main_file and main_file in configs:
        for inc in configs[main_file].includes:
            inc_basename = inc.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
            resolved_includes.append({
                "path": inc,
                "resolved": inc_basename in configs,
                "filename": inc_basename if inc_basename in configs else None,
            })

    return {
        "files": results,
        "main_file": main_file,
        "mcus": mcus,
        "includes": resolved_includes,
        "file_count": len(filenames),
    }


# ── Helpers ─────────────────────────────────────────────────────


def _reconcile_param_lines(sections: list[ConfigSection], originals: list[ConfigSection]) -> None:
    """Restore param line numbers onto rebuilt sections from a fresh parse.

    ParamUpdate cannot carry line_number (and to_dict() never serialized
    params' lines), so every reconstructed param is 0. Section-level errors
    survive, but findings computed FROM a param's line — macro Jinja body
    offsets (param.line + body offset) above all — produce a confident but
    wrong line_number (offset-only), which the frontend treats as fresh and
    authoritative and paints on the wrong line. Re-match each rebuilt section
    to its original (by line number, falling back to header order) and copy
    param lines while the key order agrees; renamed/inserted params stay 0
    and the frontend heuristic re-resolves them as designed.
    """
    by_header: dict[str, list[ConfigSection]] = {}
    for sec in originals:
        by_header.setdefault(sec.full_header, []).append(sec)
    consumed: set[int] = set()
    for sec in sections:
        pool = [s for s in by_header.get(sec.full_header, []) if id(s) not in consumed]
        if not pool:
            continue
        original = next(
            (s for s in pool if sec.line_number and s.line_number == sec.line_number),
            pool[0],
        )
        consumed.add(id(original))
        for param, orig_param in zip(sec.params, original.params):
            if param.key != orig_param.key:
                break
            param.line_number = orig_param.line_number


def _config_update_to_config_file(data: ConfigUpdate) -> ConfigFile:
    """Convert API model to parser model."""
    sections = []
    for sec_data in data.sections:
        params = [
            ConfigParam(
                key=p.key,
                value=p.value,
                is_commented_out=p.is_commented_out,
                comment=p.comment,
                separator=p.separator,
            )
            for p in sec_data.params
        ]
        section = ConfigSection(
            section_type=sec_data.section_type,
            section_name=sec_data.section_name,
            full_header=sec_data.full_header,
            line_number=sec_data.line_number,
            params=params,
            header_comments=sec_data.header_comments,
            trailing_comments=sec_data.trailing_comments,
            is_commented_out=sec_data.is_commented_out,
        )
        sections.append(section)

    # Parse-time fields do not survive the API model: to_dict() drops the
    # #*# SAVE_CONFIG tail and ParamUpdate has no line_number. Klipper
    # appends the autosave data into the loaded config (its values satisfy
    # required params), so dropping the tail made delta/vendor configs with
    # tail-only position_endstop/arm_length/delta_radius false-error
    # "Required parameter is missing". And param-anchored findings (macro
    # Jinja body offsets especially) collapse to a confident wrong line
    # when param lines are 0. Re-derive both from ONE fresh parse of the raw
    # text; params that only exist in the submitted model (graph-editor
    # additions) stay at line 0 so the frontend heuristic resolves them.
    rederived = parse_config(data.raw_text, data.filename) if data.raw_text else None
    if rederived is not None:
        _reconcile_param_lines(sections, rederived.sections)
    return ConfigFile(
        filename=data.filename,
        sections=sections,
        includes=data.includes,
        header_comments=data.header_comments,
        raw_text=data.raw_text or "",
        # unclosed_headers is a parse-time field that to_dict() doesn't
        # serialize, so re-derive it from the raw text when present — the
        # validation endpoints otherwise reconstruct the file without it and
        # the malformed-header check would silently never run.
        unclosed_headers=rederived.unclosed_headers if rederived else [],
        save_config_start_line=rederived.save_config_start_line if rederived else 0,
        save_config_sections=rederived.save_config_sections if rederived else [],
    )


def _generate_blank_config(kinematics: str) -> ConfigFile:
    """Generate a minimal blank configuration."""
    sections = [
        ConfigSection(
            section_type="mcu",
            section_name="",
            full_header="mcu",
            params=[
                ConfigParam(key="serial", value="/dev/serial/by-id/usb-..."),
            ],
        ),
        ConfigSection(
            section_type="printer",
            section_name="",
            full_header="printer",
            params=[
                ConfigParam(key="kinematics", value=kinematics),
                ConfigParam(key="max_velocity", value="300"),
                ConfigParam(key="max_accel", value="3000"),
                ConfigParam(key="max_z_velocity", value="5"),
                ConfigParam(key="max_z_accel", value="100"),
            ],
        ),
    ]

    # Add appropriate steppers
    if kinematics in ("cartesian", "corexy", "corexz", "hybrid_corexy", "hybrid_corexz"):
        for axis in ["stepper_x", "stepper_y", "stepper_z"]:
            sections.append(ConfigSection(
                section_type=axis,
                section_name="",
                full_header=axis,
                params=[
                    ConfigParam(key="step_pin", value=""),
                    ConfigParam(key="dir_pin", value=""),
                    ConfigParam(key="enable_pin", value=""),
                    ConfigParam(key="microsteps", value="16"),
                    ConfigParam(key="rotation_distance", value="40"),
                    ConfigParam(key="endstop_pin", value=""),
                    ConfigParam(key="position_endstop", value="0"),
                    ConfigParam(key="position_max", value="200"),
                ],
            ))
    elif kinematics == "delta":
        for tower in ["stepper_a", "stepper_b", "stepper_c"]:
            sections.append(ConfigSection(
                section_type=tower,
                section_name="",
                full_header=tower,
                params=[
                    ConfigParam(key="step_pin", value=""),
                    ConfigParam(key="dir_pin", value=""),
                    ConfigParam(key="enable_pin", value=""),
                    ConfigParam(key="microsteps", value="16"),
                    ConfigParam(key="rotation_distance", value="40"),
                    ConfigParam(key="endstop_pin", value=""),
                    ConfigParam(key="position_endstop", value=""),
                ],
            ))

    # Add default extruder
    sections.append(ConfigSection(
        section_type="extruder",
        section_name="",
        full_header="extruder",
        params=[
            ConfigParam(key="step_pin", value=""),
            ConfigParam(key="dir_pin", value=""),
            ConfigParam(key="enable_pin", value=""),
            ConfigParam(key="microsteps", value="16"),
            ConfigParam(key="rotation_distance", value="33.500"),
            ConfigParam(key="nozzle_diameter", value="0.400"),
            ConfigParam(key="filament_diameter", value="1.750"),
            ConfigParam(key="heater_pin", value=""),
            ConfigParam(key="sensor_type", value="Generic 3950"),
            ConfigParam(key="sensor_pin", value=""),
            ConfigParam(key="control", value="pid"),
            ConfigParam(key="pid_Kp", value="22.2"),
            ConfigParam(key="pid_Ki", value="1.08"),
            ConfigParam(key="pid_Kd", value="114"),
            ConfigParam(key="min_temp", value="0"),
            ConfigParam(key="max_temp", value="250"),
        ],
    ))

    # Add heater bed
    sections.append(ConfigSection(
        section_type="heater_bed",
        section_name="",
        full_header="heater_bed",
        params=[
            ConfigParam(key="heater_pin", value=""),
            ConfigParam(key="sensor_type", value="Generic 3950"),
            ConfigParam(key="sensor_pin", value=""),
            ConfigParam(key="control", value="pid"),
            ConfigParam(key="pid_Kp", value="54.027"),
            ConfigParam(key="pid_Ki", value="0.770"),
            ConfigParam(key="pid_Kd", value="948.182"),
            ConfigParam(key="min_temp", value="0"),
            ConfigParam(key="max_temp", value="130"),
        ],
    ))

    return ConfigFile(
        filename="printer.cfg",
        sections=sections,
        header_comments=[
            "# Klipper Configuration",
            "# Generated by Klipper Wire Configurator",
        ],
    )
