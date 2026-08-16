import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

from services.flash_jobs import FlashJobRunner  # noqa: E402

_SLEEP_SCRIPT = "import time; time.sleep({seconds})"
_PRINT_SCRIPT = "import time; print('line-1', flush=True); time.sleep(0.2); print('line-2', flush=True)"


def _py(args: list[str]) -> list[str]:
    """Build a python invocation using the running interpreter."""
    return [sys.executable, '-c', *args]


def _wait_until(predicate, timeout: float = 10.0, interval: float = 0.05) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return False


def test_start_returns_job_id_and_runs_to_completion(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start('klipper', 'build', [_py(['print("hello stream")'])], str(tmp_path))

    assert isinstance(job_id, str) and job_id

    finished = _wait_until(lambda: not runner.status(job_id)['running'])
    assert finished, 'job did not finish in time'

    status = runner.status(job_id)
    assert status['running'] is False
    assert status['kind'] == 'build'
    assert status['target'] == 'klipper'
    assert status['returncode'] == 0
    assert status['log_tail'] == ['$ ' + ' '.join(_py(['print("hello stream")'])), 'hello stream']
    assert status['raw_result']['success'] is True
    assert 'hello stream' in status['raw_result']['log']


def test_status_streams_tail_while_running(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start('klipper', 'build', [_py([_PRINT_SCRIPT])], str(tmp_path))

    # The first line should appear while the command is still sleeping.
    saw_line = _wait_until(lambda: any('line-1' in line for line in runner.status(job_id)['log_tail']))
    assert saw_line, 'streamed output did not appear in the tail while running'

    finished = _wait_until(lambda: not runner.status(job_id)['running'])
    assert finished
    status = runner.status(job_id)
    assert 'line-2' in status['log_tail']


def test_cancel_terminates_a_running_job(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start('klipper', 'flash', [_py([_SLEEP_SCRIPT.format(seconds=30)])], str(tmp_path))

    assert _wait_until(lambda: runner.status(job_id)['running'] is True)
    cancelled = runner.cancel(job_id)
    assert cancelled is True

    finished = _wait_until(lambda: not runner.status(job_id)['running'])
    assert finished, 'cancelled job did not stop'

    status = runner.status(job_id)
    assert status['running'] is False
    assert status['raw_result']['success'] is False
    assert 'Cancelled' in status['raw_result']['error']


def test_cancel_returns_false_for_unknown_or_finished_job(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')
    assert runner.cancel('nope') is False

    job_id = runner.start('klipper', 'build', [_py(['print("done")'])], str(tmp_path))
    assert _wait_until(lambda: not runner.status(job_id)['running'])
    assert runner.cancel(job_id) is False


def test_single_active_job_per_target(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start('klipper', 'build', [_py([_SLEEP_SCRIPT.format(seconds=30)])], str(tmp_path))
    try:
        runner.start('klipper', 'flash', [_py(['print("second")'])], str(tmp_path))
        assert False, 'Expected a second concurrent job for the same target to be rejected'
    except ValueError as exc:
        assert 'already running' in str(exc)

    # A different target is unaffected.
    other_id = runner.start('katapult', 'build', [_py(['print("other")'])], str(tmp_path))
    assert other_id != job_id


def test_parallel_jobs_on_different_targets(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    klipper_id = runner.start('klipper', 'build', [_py([_SLEEP_SCRIPT.format(seconds=1)])], str(tmp_path))
    katapult_id = runner.start('katapult', 'flash', [_py([_SLEEP_SCRIPT.format(seconds=1)])], str(tmp_path))

    assert klipper_id != katapult_id
    assert _wait_until(lambda: not runner.status(klipper_id)['running'])
    assert _wait_until(lambda: not runner.status(katapult_id)['running'])


def test_command_failure_records_error_and_log(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start('klipper', 'build', [_py(['import sys; print("boom"); sys.exit(3)'])], str(tmp_path))

    assert _wait_until(lambda: not runner.status(job_id)['running'])
    status = runner.status(job_id)
    assert status['raw_result']['success'] is False
    assert status['returncode'] == 3
    assert 'exit code 3' in status['raw_result']['error']
    assert 'boom' in status['raw_result']['log']


def test_sequential_commands_run_in_order(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start(
        'klipper',
        'build',
        [
            _py(['print("first")']),
            _py(['print("second")']),
        ],
        str(tmp_path),
    )

    assert _wait_until(lambda: not runner.status(job_id)['running'])
    status = runner.status(job_id)
    tail = status['log_tail']
    assert tail.index('first') < tail.index('second')
    assert status['raw_result']['success'] is True


def test_cleanup_commands_run_after_success(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start(
        'klipper',
        'flash',
        [_py(['print("main")'])],
        str(tmp_path),
        cleanup_commands=[_py(['print("cleanup")'])],
    )

    assert _wait_until(lambda: not runner.status(job_id)['running'])
    status = runner.status(job_id)
    tail = status['log_tail']
    assert tail.index('main') < tail.index('cleanup')
    assert status['raw_result']['success'] is True
    assert 'cleanup' in status['raw_result']['log']


def test_cleanup_commands_run_after_failure(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start(
        'klipper',
        'flash',
        [_py(['import sys; print("boom"); sys.exit(3)'])],
        str(tmp_path),
        cleanup_commands=[_py(['print("cleanup")'])],
    )

    assert _wait_until(lambda: not runner.status(job_id)['running'])
    status = runner.status(job_id)
    assert status['raw_result']['success'] is False
    assert 'cleanup' in status['raw_result']['log']


def test_cleanup_commands_run_after_cancel(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start(
        'klipper',
        'flash',
        [_py([_SLEEP_SCRIPT.format(seconds=5)])],
        str(tmp_path),
        cleanup_commands=[_py(['print("cleanup")'])],
    )

    assert _wait_until(lambda: runner.status(job_id)['running'])
    runner.cancel(job_id)

    assert _wait_until(lambda: not runner.status(job_id)['running'])
    status = runner.status(job_id)
    assert status['raw_result']['success'] is False
    assert 'Cancelled.' in status['raw_result']['error']
    assert 'cleanup' in status['raw_result']['log']


def test_cleanup_failure_does_not_flip_main_result(tmp_path):
    runner = FlashJobRunner(log_dir=tmp_path / 'logs')

    job_id = runner.start(
        'klipper',
        'flash',
        [_py(['print("main")'])],
        str(tmp_path),
        cleanup_commands=[_py(['import sys; sys.exit(9)'])],
    )

    assert _wait_until(lambda: not runner.status(job_id)['running'])
    status = runner.status(job_id)
    assert status['raw_result']['success'] is True
    assert 'Cleanup command exited with code 9' in status['raw_result']['log']
