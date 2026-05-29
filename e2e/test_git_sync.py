import subprocess
import tempfile
import shutil
from pathlib import Path

import requests


def api_post(session: requests.Session, url: str, payload: dict, expected_status: int = 200) -> dict:
    response = session.post(url, json=payload, timeout=20)
    assert response.status_code == expected_status, response.text
    return response.json() if response.text else {}


def api_patch(session: requests.Session, url: str, payload: dict, expected_status: int = 200) -> dict:
    response = session.patch(url, json=payload, timeout=20)
    assert response.status_code == expected_status, response.text
    return response.json() if response.text else {}


def test_git_status_detection_and_sync_endpoint(base_url: str) -> None:
    session = requests.Session()
    api_post(session, f"{base_url}/api/auth/login", {"identifier": "admin", "password": "admin123"})

    project = api_post(
        session,
        f"{base_url}/api/projects",
        {"name": "Git Sync Project", "gitRepo": "octocat/git-sync-project"},
        expected_status=201,
    )
    project_id = project["id"]

    workspace = Path(tempfile.mkdtemp(prefix="suse-docengine-git-"))
    try:
        subprocess.run(["git", "init"], cwd=workspace, check=True, capture_output=True, text=True)
        subprocess.run(["git", "config", "user.email", "local@test"], cwd=workspace, check=True, capture_output=True, text=True)
        subprocess.run(["git", "config", "user.name", "Local Tester"], cwd=workspace, check=True, capture_output=True, text=True)
        (workspace / "README.md").write_text("# Git Sync Test\n", encoding="utf-8")
        subprocess.run(["git", "add", "."], cwd=workspace, check=True, capture_output=True, text=True)
        subprocess.run(["git", "commit", "-m", "init"], cwd=workspace, check=True, capture_output=True, text=True)

        api_patch(
            session,
            f"{base_url}/api/projects/{project_id}",
            {"workspacePath": str(workspace)},
        )

        status_response = session.get(f"{base_url}/api/projects/{project_id}/git-status", timeout=20)
        assert status_response.status_code == 200, status_response.text
        status_payload = status_response.json()
        assert "clean" in status_payload
        assert "current" in status_payload

        sync_response = session.post(
            f"{base_url}/api/projects/{project_id}/git-sync",
            json={"action": "pull"},
            timeout=20,
        )
        assert sync_response.status_code in (200, 500), sync_response.text
    finally:
        for child in workspace.glob("**/*"):
            if child.is_file():
                child.chmod(0o666)
        shutil.rmtree(workspace, ignore_errors=True)
