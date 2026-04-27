import sys
from pathlib import Path

sys.path.insert(0, 'backend')

from services.klipper_firmware import (  # noqa: E402
    get_klipper_firmware_artifact_path,
    list_klipper_firmware_artifacts,
    pick_primary_klipper_firmware_artifact,
)


def test_list_klipper_firmware_artifacts_prefers_known_primary_names(tmp_path):
    out_dir = tmp_path / 'out'
    out_dir.mkdir()
    (out_dir / 'klipper.bin').write_bytes(b'bin')
    (out_dir / 'klipper.uf2').write_bytes(b'uf2')
    (out_dir / 'notes.txt').write_text('ignore me', encoding='utf-8')

    artifacts = list_klipper_firmware_artifacts(tmp_path)

    assert [artifact['name'] for artifact in artifacts] == ['klipper.uf2', 'klipper.bin']
    assert pick_primary_klipper_firmware_artifact(artifacts)['name'] == 'klipper.uf2'


def test_get_klipper_firmware_artifact_path_rejects_path_traversal(tmp_path, monkeypatch):
    checkout = tmp_path / 'klipper'
    (checkout / 'out').mkdir(parents=True)
    (checkout / 'out' / 'klipper.bin').write_bytes(b'firmware')

    monkeypatch.setattr(
        'services.klipper_firmware.resolve_klipper_checkout',
        lambda requested_path=None: (checkout, None),
    )

    try:
        get_klipper_firmware_artifact_path('../secrets.bin')
        assert False, 'Expected invalid artifact filename to be rejected'
    except ValueError as exc:
        assert 'Invalid artifact filename' in str(exc)


def test_get_klipper_firmware_artifact_path_returns_existing_artifact(tmp_path, monkeypatch):
    checkout = tmp_path / 'klipper'
    (checkout / 'out').mkdir(parents=True)
    artifact = checkout / 'out' / 'klipper.bin'
    artifact.write_bytes(b'firmware')

    monkeypatch.setattr(
        'services.klipper_firmware.resolve_klipper_checkout',
        lambda requested_path=None: (checkout, None),
    )

    resolved = get_klipper_firmware_artifact_path('klipper.bin')

    assert resolved == artifact