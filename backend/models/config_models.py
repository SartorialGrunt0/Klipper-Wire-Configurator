"""Pydantic models for API requests and responses."""
from __future__ import annotations

from pydantic import BaseModel
from typing import List, Optional


class ParamUpdate(BaseModel):
    key: str
    value: str
    is_commented_out: bool = False
    comment: str = ""
    separator: str = ":"


class SectionUpdate(BaseModel):
    full_header: str
    section_type: str
    section_name: str = ""
    line_number: int = 0
    params: list[ParamUpdate]
    header_comments: list[str] = []
    trailing_comments: list[str] = []
    is_commented_out: bool = False


class ConfigUpdate(BaseModel):
    filename: str
    sections: list[SectionUpdate]
    includes: list[str] = []
    header_comments: list[str] = []
    raw_text: Optional[str] = None


class ProjectValidationRequest(BaseModel):
    config_files: list[ConfigUpdate]


class WarningAcknowledgementRequest(BaseModel):
    section: SectionUpdate


class BulkWarningIdentity(BaseModel):
    """One warning finding to bulk-acknowledge (Phase 4 save gate)."""
    file: str
    code: str
    section: str
    param: str = ""
    extra: str = ""


class BulkWarningAcknowledgementRequest(BaseModel):
    identities: List[BulkWarningIdentity]


class ProjectFile(BaseModel):
    filename: str
    content: str


class Project(BaseModel):
    name: str
    files: list[ProjectFile]


class GraphNode(BaseModel):
    id: str
    type: str  # "hardware", "sub_component", "feature"
    component_type: str  # "mainboard", "sbc", "toolhead", etc.
    section_header: str  # Config section header
    label: str
    position_x: float = 0
    position_y: float = 0
    parent_id: Optional[str] = None
    custom_image: Optional[str] = None
    config_file: str = "printer.cfg"


class GraphEdge(BaseModel):
    id: str
    source: str
    target: str
    edge_type: str  # "communication", "configuration"
    comm_type: Optional[str] = None  # "usb", "canbus", "uart"


class GraphLayout(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class ProjectSave(BaseModel):
    name: str
    config_files: list[ConfigUpdate]
    graph_layout: GraphLayout


class ExportRequest(BaseModel):
    project: ProjectSave


class GenerateRequest(BaseModel):
    template: Optional[str] = None  # Example config filename
    kinematics: str = "cartesian"
    board_name: str = ""
