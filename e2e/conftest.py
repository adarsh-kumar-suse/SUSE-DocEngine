import os
import shutil
import signal
import subprocess
import time
from pathlib import Path
from typing import Iterator

import pytest
import requests


ROOT_DIR = Path(__file__).resolve().parents[1]
BASE_URL = os.getenv("E2E_BASE_URL", "http://127.0.0.1:3100")
HEALTH_URL = f"{BASE_URL}/api/health"
TEST_DATA_DIR = ROOT_DIR / "data-test-e2e"


def _wait_for_server(timeout_seconds: int = 120) -> None:
    started_at = time.time()
    last_error = ""
    while time.time() - started_at < timeout_seconds:
        try:
            response = requests.get(HEALTH_URL, timeout=2)
            if response.status_code == 200:
                return
            last_error = f"Unexpected status: {response.status_code}"
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
        time.sleep(1)
    raise RuntimeError(f"Server did not become healthy in time. Last error: {last_error}")


@pytest.fixture(scope="session")
def app_server() -> Iterator[dict[str, str]]:
    if os.getenv("E2E_USE_EXISTING_SERVER") == "1":
        _wait_for_server()
        yield {"base_url": BASE_URL, "data_dir": str(TEST_DATA_DIR)}
        return

    if TEST_DATA_DIR.exists():
        shutil.rmtree(TEST_DATA_DIR)
    TEST_DATA_DIR.mkdir(parents=True, exist_ok=True)

    env = os.environ.copy()
    env["APP_URL"] = BASE_URL
    env["SESSION_COOKIE_SECURE"] = "false"
    env["DATA_DIR"] = str(TEST_DATA_DIR)
    env["PORT"] = BASE_URL.rsplit(":", 1)[-1]

    npm_command = shutil.which("npm.cmd") or shutil.which("npm")
    if not npm_command:
        raise RuntimeError("npm executable not found in PATH for test harness.")

    process = subprocess.Popen(  # noqa: S603
        [npm_command, "run", "dev"],
        cwd=str(ROOT_DIR),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    try:
        _wait_for_server()
        yield {"base_url": BASE_URL, "data_dir": str(TEST_DATA_DIR)}
    finally:
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


@pytest.fixture(scope="session")
def base_url(app_server: dict[str, str]) -> str:
    return app_server["base_url"]
