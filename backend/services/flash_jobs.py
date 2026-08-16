"""Background job runner for flash-target build/flash commands.

Runs a command sequence via Popen in a daemon thread, streaming stdout to a
rotating tail buffer (last ``_TAIL_LIMIT`` lines) and to a per-job log file
under ``~/.cache/kwc-flash-logs/``. Enforces one active job per target and
supports cancel via process-group termination.

The runner is intentionally decoupled from the flash service: it returns a
generic ``raw_result`` (``{success, error, log, returncode}``); the API layer
enriches it into the full command-result shape once the job finishes.
"""
from __future__ import annotations

import logging
import os
import signal
import subprocess
import threading
import time
import uuid
from collections import deque
from pathlib import Path

logger = logging.getLogger(__name__)

_TAIL_LIMIT = 200
_COMMAND_TIMEOUT_SECONDS = 900

_SUPPORTED_TARGETS = {"klipper", "katapult"}


class FlashJob:
    def __init__(
        self,
        *,
        job_id: str,
        target: str,
        kind: str,
        commands: list[list[str]],
        checkout_path: str,
        log_path: Path,
        flash_device: str = "",
        flash_method: str = "",
        cleanup_commands: list[list[str]] | None = None,
    ) -> None:
        self.job_id = job_id
        self.target = target
        self.kind = kind
        self.commands = commands
        self.cleanup_commands = cleanup_commands or []
        self.checkout_path = checkout_path
        self.log_path = log_path
        self.flash_device = flash_device
        self.flash_method = flash_method
        self.created_at = time.monotonic()
        self.tail: deque[str] = deque(maxlen=_TAIL_LIMIT)
        self.lock = threading.Lock()
        self.running = True
        self.cancelled = False
        self.timed_out = False
        self.process: subprocess.Popen | None = None
        self.returncode: int | None = None
        self.raw_result: dict | None = None
        self.finished_at: float | None = None


class FlashJobRunner:
    """Registry of running/finished flash jobs with streaming output."""

    def __init__(self, log_dir: Path | None = None, command_timeout: float = _COMMAND_TIMEOUT_SECONDS) -> None:
        self._jobs: dict[str, FlashJob] = {}
        self._active_by_target: dict[str, str] = {}
        self._lock = threading.Lock()
        self._log_dir = log_dir or (Path.home() / ".cache" / "kwc-flash-logs")
        self._command_timeout = command_timeout

    def start(
        self,
        target: str,
        kind: str,
        commands: list[list[str]],
        checkout_path: str,
        flash_device: str = "",
        flash_method: str = "",
        cleanup_commands: list[list[str]] | None = None,
    ) -> str:
        """Start a job and return its id. Raises ValueError if the target is busy."""
        normalized = str(target).strip().lower()
        if normalized not in _SUPPORTED_TARGETS:
            raise ValueError(f"Unsupported flash target: {target}")
        if not commands:
            raise ValueError("A flash job needs at least one command.")

        job_id = uuid.uuid4().hex[:12]
        with self._lock:
            active_id = self._active_by_target.get(normalized)
            if active_id is not None:
                active = self._jobs.get(active_id)
                if active is not None and active.running:
                    raise ValueError(
                        f"A {active.kind} job is already running for the {normalized} target."
                    )
            self._log_dir.mkdir(parents=True, exist_ok=True)
            log_path = self._log_dir / f"{normalized}-{kind}-{job_id}.log"
            job = FlashJob(
                job_id=job_id,
                target=normalized,
                kind=kind,
                commands=commands,
                checkout_path=str(checkout_path),
                log_path=log_path,
                flash_device=flash_device,
                flash_method=flash_method,
                cleanup_commands=cleanup_commands,
            )
            self._jobs[job_id] = job
            self._active_by_target[normalized] = job_id

        thread = threading.Thread(
            target=self._run,
            args=(job,),
            name=f"kwc-flash-{kind}-{job_id}",
            daemon=True,
        )
        thread.start()
        return job_id

    def status(self, job_id: str) -> dict:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        with job.lock:
            return {
                "job_id": job.job_id,
                "target": job.target,
                "kind": job.kind,
                "checkout_path": job.checkout_path,
                "flash_device": job.flash_device,
                "flash_method": job.flash_method,
                "running": job.running,
                "returncode": job.returncode,
                "log_tail": list(job.tail),
                "raw_result": job.raw_result,
            }

    def cancel(self, job_id: str) -> bool:
        """Terminate a running job. Returns False if it is unknown or already done."""
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            return False
        with job.lock:
            if not job.running:
                return False
            job.cancelled = True
            process = job.process
        if process is not None:
            self._terminate(process)
        return True

    # ── internals ────────────────────────────────────────────────

    def _run(self, job: FlashJob) -> None:
        success, error = False, None
        try:
            for command in job.commands:
                if self._is_cancelled(job):
                    success, error = False, "Cancelled."
                    break
                self._append(job, f"$ {' '.join(command)}")
                try:
                    process = subprocess.Popen(
                        command,
                        cwd=job.checkout_path,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT,
                        text=True,
                        bufsize=1,
                        start_new_session=True,
                    )
                except FileNotFoundError:
                    success, error = False, f"Command not found: {command[0]}"
                    break
                with job.lock:
                    job.process = process
                    already_cancelled = job.cancelled
                if already_cancelled:
                    # Cancel landed between the loop-top check and Popen:
                    # terminate now, since the stdout reader would otherwise
                    # block forever waiting for output that never comes.
                    self._terminate(process)
                    process.wait()
                    success, error = False, "Cancelled."
                    break

                timer = threading.Timer(self._command_timeout, self._timeout_process, args=(job, process))
                timer.daemon = True
                timer.start()
                try:
                    if process.stdout is not None:
                        for raw_line in process.stdout:
                            if self._is_cancelled(job):
                                break
                            self._append(job, raw_line.rstrip("\n"))
                finally:
                    timer.cancel()
                process.wait()

                with job.lock:
                    job.process = None
                    job.returncode = process.returncode
                    returncode = process.returncode
                    timed_out = job.timed_out
                    cancelled = job.cancelled

                if cancelled:
                    success, error = False, "Cancelled."
                    break
                if timed_out:
                    success, error = False, f"{' '.join(command)} timed out."
                    break
                if returncode != 0:
                    success, error = False, f"{' '.join(command)} failed with exit code {returncode}."
                    break
            else:
                success = True
        except Exception as exc:  # pragma: no cover - safety net for runaway jobs
            logger.exception("flash job %s crashed", job.job_id)
            success, error = False, f"Job crashed: {exc}"

        # Cleanup commands (e.g. `systemctl start klipper`) always run after
        # the main sequence, even on failure/cancel/timeout, so services the
        # job stopped are guaranteed to come back.
        self._run_cleanup(job)
        self._finish(job, success, error)

    def _run_cleanup(self, job: FlashJob) -> None:
        if not job.cleanup_commands:
            return
        for command in job.cleanup_commands:
            self._append(job, f"$ {' '.join(command)}")
            try:
                completed = subprocess.run(
                    command,
                    cwd=job.checkout_path,
                    capture_output=True,
                    text=True,
                    timeout=60,
                    check=False,
                )
            except FileNotFoundError:
                self._append(job, f"Cleanup command not found: {command[0]}")
                continue
            except subprocess.TimeoutExpired:
                self._append(job, f"Cleanup command timed out: {' '.join(command)}")
                continue
            output = "\n".join(chunk for chunk in (completed.stdout, completed.stderr) if chunk)
            if output:
                for raw_line in output.splitlines():
                    self._append(job, raw_line)
            if completed.returncode != 0:
                self._append(job, f"Cleanup command exited with code {completed.returncode}")

    def _is_cancelled(self, job: FlashJob) -> bool:
        with job.lock:
            return job.cancelled

    def _timeout_process(self, job: FlashJob, process: subprocess.Popen) -> None:
        with job.lock:
            job.timed_out = True
        self._terminate(process)

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        try:
            os.killpg(os.getpgid(process.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                process.terminate()
            except ProcessLookupError:
                pass

    def _append(self, job: FlashJob, line: str) -> None:
        with job.lock:
            job.tail.append(line)
        with job.log_path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")

    def _finish(self, job: FlashJob, success: bool, error: str | None) -> None:
        with job.lock:
            job.running = False
            job.finished_at = time.monotonic()
        log = job.log_path.read_text(encoding="utf-8") if job.log_path.exists() else ""
        with job.lock:
            job.raw_result = {
                "success": success,
                "error": error,
                "log": log,
                "returncode": job.returncode,
            }
        logger.info(
            "flash job %s (%s %s) finished: success=%s elapsed=%.1fs",
            job.job_id,
            job.target,
            job.kind,
            success,
            job.finished_at - job.created_at,
        )
