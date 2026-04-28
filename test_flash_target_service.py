import sys

sys.path.insert(0, 'backend')

from services.flash_targets import (  # noqa: E402
    list_flash_target_artifacts,
    pick_primary_flash_target_artifact,
)


def test_list_flash_target_artifacts_prefers_katapult_primary_names(tmp_path):
    out_dir = tmp_path / 'out'
    out_dir.mkdir()
    (out_dir / 'katapult.bin').write_bytes(b'bin')
    (out_dir / 'katapult.uf2').write_bytes(b'uf2')
    (out_dir / 'deployer.bin').write_bytes(b'deployer')

    artifacts = list_flash_target_artifacts('katapult', tmp_path)

    assert [artifact['name'] for artifact in artifacts] == ['katapult.uf2', 'katapult.bin', 'deployer.bin']
    assert pick_primary_flash_target_artifact('katapult', artifacts)['name'] == 'katapult.uf2'