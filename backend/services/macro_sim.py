"""Macro geometry helpers ported from frontend/src/utils/macroDesigner.ts.

⚠️ SYNC WARNING — mirrored geometry
This module mirrors the geometry in frontend/src/utils/macroDesigner.ts
(isPointInMoveBounds / findZoneHit / findPathZoneHit /
lineSegmentIntersectsRect) plus a small G90/G91 position tracker, so the MCP
validate_macro tool reports out-of-bounds moves and no-go zone hits with the
same geometry the Macro Designer uses in the UI.

If you change the geometry in EITHER file, apply the same change to the other:
- backend/services/macro_sim.py          (this file — used by the MCP tool)
- frontend/src/utils/macroDesigner.ts    (the Macro Designer UI)
Otherwise the AI validator and the designer will disagree about what is in
bounds and where the no-go zones are.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# ── Geometry ───────────────────────────────────────────────────────────


@dataclass
class NoGoZone:
    x: float = 0.0
    y: float = 0.0
    width: float = 10.0
    height: float = 10.0


@dataclass
class MoveBounds:
    """Axis travel limits plus rectangular no-go zones."""

    min_x: float = 0.0
    max_x: float = 200.0
    min_y: float = 0.0
    max_y: float = 200.0
    min_z: float = 0.0
    max_z: float = 200.0
    zones: list[NoGoZone] = field(default_factory=list)


def is_point_in_move_bounds(bounds: MoveBounds, x: float, y: float) -> bool:
    return bounds.min_x <= x <= bounds.max_x and bounds.min_y <= y <= bounds.max_y


def find_zone_hit(bounds: MoveBounds, x: float, y: float) -> NoGoZone | None:
    for zone in bounds.zones:
        if zone.x <= x <= zone.x + zone.width and zone.y <= y <= zone.y + zone.height:
            return zone
    return None


def _line_segment_intersects_rect(
    x1: float, y1: float, x2: float, y2: float,
    rx: float, ry: float, rw: float, rh: float,
) -> bool:
    """Liang-Barsky line clipping against an axis-aligned rectangle.

    Ported verbatim from lineSegmentIntersectsRect in macroDesigner.ts.
    """
    dx = x2 - x1
    dy = y2 - y1
    t_min = 0.0
    t_max = 1.0
    edges = (
        (-dx, x1 - rx),
        (dx, rx + rw - x1),
        (-dy, y1 - ry),
        (dy, ry + rh - y1),
    )
    for p, q in edges:
        if abs(p) < 1e-10:
            if q < 0:
                return False
        else:
            t = q / p
            if p < 0:
                t_min = max(t_min, t)
            else:
                t_max = min(t_max, t)
            if t_min > t_max:
                return False
    return True


def find_path_zone_hit(
    bounds: MoveBounds,
    x1: float, y1: float,
    x2: float, y2: float,
) -> NoGoZone | None:
    for zone in bounds.zones:
        if _line_segment_intersects_rect(x1, y1, x2, y2, zone.x, zone.y, zone.width, zone.height):
            return zone
    return None


# ── Move parsing / tracking ────────────────────────────────────────────

# X/Y/Z coordinate parameters on a G0/G1 line, e.g. "G1 X200 Y10 Z0.4".
MOVE_PARAM_RE = re.compile(r"([XYZ])\s*([+-]?[0-9]*\.?[0-9]+)", re.IGNORECASE)


class MoveTracker:
    """Tracks G90/G91 mode and the current X/Y/Z across G0/G1 moves so
    path checks can use the previous position.

    This is a deliberately small subset of the Macro Designer's runtime
    state (frontend gcodeSimulator.ts) — enough for bounds and zone checks.
    """

    def __init__(self) -> None:
        self.x: float | None = None
        self.y: float | None = None
        self.z: float | None = None
        self.prev_x: float | None = None
        self.prev_y: float | None = None
        self.absolute = True

    def set_mode(self, absolute: bool) -> None:
        self.absolute = absolute

    def home(self) -> None:
        """G28 — position becomes the home position (assumed 0,0,0)."""
        self.x = 0.0
        self.y = 0.0
        self.z = 0.0

    def move(self, x: float | None = None, y: float | None = None,
             z: float | None = None) -> tuple[float | None, float | None, float | None]:
        """Apply a G0/G1 with optional X/Y/Z params; returns the target position."""
        self.prev_x, self.prev_y = self.x, self.y
        if x is not None:
            self.x = x if self.absolute else (self.x or 0.0) + x
        if y is not None:
            self.y = y if self.absolute else (self.y or 0.0) + y
        if z is not None:
            self.z = z if self.absolute else (self.z or 0.0) + z
        return self.x, self.y, self.z
