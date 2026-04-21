"""API routes for Klipper Wire Configurator."""
from __future__ import annotations

import json
from pathlib import Path
from typing import List

from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.responses import PlainTextResponse

from models.config_models import (
    ConfigUpdate,
    ExportRequest,
    GenerateRequest,
    ParamUpdate,
    ProjectSave,
    SectionUpdate,
    WarningAcknowledgementRequest,
)
from parser.config_parser import ConfigFile, ConfigParam, ConfigSection, parse_config
from parser.config_schema import (
    SECTION_DEFS,
    ParamType,
    get_all_section_types,
    get_section_def,
    get_sections_by_category,
    get_sections_by_group,
)
from parser.config_writer import write_config, smart_export
from parser.validator import validate_config
from services.board_detector import (
    BOARD_TYPE_DIRS,
    detect_board_from_config,
    fuzzy_match_examples,
    get_available_examples,
)
from services.warning_acknowledgments import acknowledge_warning_for_section

router = APIRouter()

REFERENCE_DIR = Path(__file__).parent.parent.parent / "reference"
PROJECTS_DIR = Path(__file__).parent.parent / "projects"


def _resolve_config_path(filename: str) -> Path | None:
    """Find a config file by name, searching type subdirectories first."""
    config_dir = REFERENCE_DIR / "config"
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


# ── Import / Parse ──────────────────────────────────────────────


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
    results = {}
    configs = {}

    for f in files:
        content = await f.read()
        text = content.decode("utf-8", errors="replace")
        # Strip any path prefix the browser may include (e.g. "config/printer.cfg" → "printer.cfg")
        filename = Path(f.filename or "unknown.cfg").name or "unknown.cfg"

        # Only process .cfg files
        if not filename.endswith(".cfg"):
            continue

        config = parse_config(text, filename)
        validation = validate_config(config, is_multi_file=len(files) > 1)
        board_info = detect_board_from_config(config)

        configs[filename] = config
        results[filename] = {
            "config": config.to_dict(),
            "validation": validation.to_dict(),
            "board_info": board_info,
        }

    if not results:
        raise HTTPException(status_code=400, detail="No .cfg files found in upload")

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


@router.post("/warning-acknowledgements")
async def acknowledge_warning_api(data: WarningAcknowledgementRequest):
    """Persist a section whose unknown-section warning has been acknowledged."""
    section = ConfigSection(
        section_type=data.section.section_type,
        section_name=data.section.section_name,
        full_header=data.section.full_header,
        line_number=0,
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
    config_ref = REFERENCE_DIR / "reference_docs" / "klipper_docs" / "Config_Reference.md"
    if not config_ref.exists():
        raise HTTPException(status_code=404, detail="Config_Reference.md not found")
    return {"content": config_ref.read_text(encoding="utf-8", errors="replace")}


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


# ── Helpers ─────────────────────────────────────────────────────


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
            params=params,
            header_comments=sec_data.header_comments,
            trailing_comments=sec_data.trailing_comments,
            is_commented_out=sec_data.is_commented_out,
        )
        sections.append(section)

    return ConfigFile(
        filename=data.filename,
        sections=sections,
        includes=data.includes,
        header_comments=data.header_comments,
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
