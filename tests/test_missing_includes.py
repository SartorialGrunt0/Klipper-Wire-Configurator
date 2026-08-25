"""
3i (F19): a non-glob [include] whose target file isn't in the loaded
project must be flagged; glob patterns that match nothing are legal.

Ground truth (klippy/configfile.py _resolve_include):
    include_glob = os.path.join(dirname, include_spec)
    include_filenames = glob.glob(include_glob)
    if not include_filenames and not glob.has_magic(include_glob):
        raise error("Include file '%s' does not exist" % (include_glob,))

So a PLAIN include that resolves to nothing is a Klipper startup hard-fail,
while a GLOB that matches nothing is explicitly legal.

KWC validates in-memory (uploads / the AI draft set), not a live config tree,
so the target is resolved against the LOADED project files (basename match —
mirroring the import route's include resolution). Severity: warning, because
KWC often loads a PARTIAL import (single printer.cfg without its tree) and a
hard error would false-positive on the user's own workflow (plan decision).

Globs are never flagged — in an in-memory set a glob can never be
"resolved", and matching nothing is legal in Klipper.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from parser.config_parser import parse_config  # noqa: E402
from parser.validator import validate_project_configs  # noqa: E402


def _project(files: dict[str, str]) -> dict:
    return validate_project_configs({
        name: parse_config(text, name) for name, text in files.items()
    })


def _include_warnings(results: dict) -> list:
    return [
        e for fr in results.values() for e in fr.errors
        if e.severity == "warning" and "include" in e.section.lower()
    ]


def test_missing_plain_include_is_warning():
    results = _project({
        "printer.cfg": "[include missing.cfg]\n[printer]\nkinematics: cartesian\n",
        "other.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    warnings = _include_warnings(results)
    assert any("missing.cfg" in e.message for e in warnings), \
        f"missing plain include must warn, got: {[e.message for e in warnings]}"


def test_present_include_not_flagged():
    results = _project({
        "printer.cfg": "[include other.cfg]\n[printer]\nkinematics: cartesian\n",
        "other.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    assert not _include_warnings(results), "present include must not warn"


def test_subdir_include_resolves_by_basename():
    results = _project({
        "printer.cfg": "[include macros/other.cfg]\n[printer]\nkinematics: cartesian\n",
        "other.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    assert not _include_warnings(results), "basename-matched include must not warn"


def test_subdir_include_missing_warns():
    results = _project({
        "printer.cfg": "[include macros/other.cfg]\n[printer]\nkinematics: cartesian\n",
        "unrelated.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    warnings = _include_warnings(results)
    assert any("other.cfg" in e.message for e in warnings), \
        "include whose basename is absent must warn"


def test_glob_include_never_flagged():
    # glob.has_magic is true -> matching nothing is legal in Klipper, and an
    # in-memory set can never resolve a glob, so it must never be flagged.
    results = _project({
        "printer.cfg": (
            "[include macros/*.cfg]\n"
            "[include *.cfg]\n"
            "[printer]\n"
            "kinematics: cartesian\n"
        ),
        "other.cfg": "[gcode_macro X]\ngcode: G28\n",
    })
    assert not _include_warnings(results), "glob includes must never warn"


def test_transitive_includes_checked():
    # The include chain printer -> a -> b: a missing link anywhere in the
    # ACTIVE chain is flagged.
    results = _project({
        "printer.cfg": "[include a.cfg]\n[printer]\nkinematics: cartesian\n",
        "a.cfg": "[include b.cfg]\n[gcode_macro X]\ngcode: G28\n",
    })
    warnings = _include_warnings(results)
    assert any("b.cfg" in e.message for e in warnings), \
        f"missing transitive include must warn, got: {[e.message for e in warnings]}"


def test_single_file_not_flagged():
    # File-local validation never sees the project — a lone file with a
    # missing include is exactly the partial-import case the warning exists
    # to tolerate (and there is no project to resolve against).
    from parser.validator import validate_config
    result = validate_config(parse_config(
        "[include missing.cfg]\n[printer]\nkinematics: cartesian\n", "printer.cfg"))
    assert not [e for e in result.errors if "include" in e.section.lower()], \
        "single-file validation must not flag includes"
