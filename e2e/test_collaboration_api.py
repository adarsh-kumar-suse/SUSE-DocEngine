import requests


def api_post(session: requests.Session, url: str, payload: dict, expected_status: int = 200) -> dict:
    response = session.post(url, json=payload, timeout=20)
    assert response.status_code == expected_status, response.text
    if not response.text:
        return {}
    return response.json()


def api_get(session: requests.Session, url: str, expected_status: int = 200) -> dict | list:
    response = session.get(url, timeout=20)
    assert response.status_code == expected_status, response.text
    if not response.text:
        return {}
    return response.json()


def login_admin(session: requests.Session, base_url: str) -> dict:
    payload = {"identifier": "admin", "password": "admin123"}
    return api_post(session, f"{base_url}/api/auth/login", payload)


def signup_or_login(session: requests.Session, base_url: str, email: str, username: str, password: str) -> dict:
    signup_payload = {
        "email": email,
        "username": username,
        "displayName": username,
        "password": password,
    }
    signup_response = session.post(f"{base_url}/api/auth/signup", json=signup_payload, timeout=20)
    if signup_response.status_code == 201:
        return signup_response.json()
    assert signup_response.status_code in (409, 400), signup_response.text
    login_payload = {"identifier": username, "password": password}
    return api_post(session, f"{base_url}/api/auth/login", login_payload)


def test_personal_project_exists_after_login(base_url: str) -> None:
    session = requests.Session()
    login_admin(session, base_url)
    projects = api_get(session, f"{base_url}/api/projects")
    assert isinstance(projects, list)
    assert len(projects) >= 1
    assert any(project.get("isPersonal") is True for project in projects)


def test_collaboration_invite_publish_merge_flow(base_url: str) -> None:
    admin = requests.Session()
    user_b = requests.Session()
    user_c = requests.Session()

    login_admin(admin, base_url)
    signup_or_login(user_b, base_url, "collab-b@local", "collab_b", "collab123")
    signup_or_login(user_c, base_url, "collab-c@local", "collab_c", "collab123")

    project = api_post(
        admin,
        f"{base_url}/api/projects",
        {"name": "Collab Alpha", "description": "Project for collaboration test", "gitRepo": "octocat/collab-alpha"},
        expected_status=201,
    )
    project_id = project["id"]

    invite = api_post(
        admin,
        f"{base_url}/api/projects/{project_id}/invites",
        {"email": "collab-b@local", "role": "editor"},
        expected_status=201,
    )
    invite_token = invite["token"]

    accepted = api_post(
        user_b,
        f"{base_url}/api/invites/accept",
        {"token": invite_token},
    )
    assert accepted["success"] is True

    members = api_get(user_b, f"{base_url}/api/projects/{project_id}/members")
    assert any(member.get("email") == "collab-b@local" for member in members)

    pipeline = api_post(
        user_b,
        f"{base_url}/api/projects/{project_id}/pipelines",
        {"name": "Pipeline One", "initialContent": {"adoc": "= Title"}},
        expected_status=201,
    )
    pipeline_id = pipeline["id"]
    branch = api_post(
        user_b,
        f"{base_url}/api/projects/{project_id}/pipelines/{pipeline_id}/branches",
        {"name": "feature/collab-b"},
        expected_status=201,
    )
    branch_id = branch["id"]

    work_item = api_post(
        user_b,
        f"{base_url}/api/projects/{project_id}/work-items",
        {"title": "Review partner content", "type": "task"},
        expected_status=201,
    )
    work_item_id = work_item["id"]

    working_copy = api_post(
        user_b,
        f"{base_url}/api/projects/{project_id}/pipelines/{pipeline_id}/working-copy",
        {"content": {"adoc": "= Updated Title"}},
        expected_status=201,
    )
    version_id = working_copy["versionId"]

    publish = api_post(
        user_b,
        f"{base_url}/api/projects/{project_id}/pipelines/{pipeline_id}/publish",
        {"versionId": version_id, "changeSummary": "Updated title"},
    )
    assert publish["success"] is True
    commit = api_post(
        user_b,
        f"{base_url}/api/projects/{project_id}/pipelines/{pipeline_id}/commits",
        {
            "branchId": branch_id,
            "versionId": version_id,
            "message": "Update title for collaboration review",
            "linkedWorkItemId": work_item_id,
        },
        expected_status=201,
    )
    commit_id = commit["id"]
    push_status = api_get(
        user_b,
        f"{base_url}/api/projects/{project_id}/pipelines/{pipeline_id}/push-status",
    )
    assert push_status.get("pipelineId") == pipeline_id
    compare = api_get(
        admin,
        f"{base_url}/api/projects/{project_id}/pipeline-compare?leftPipelineId={pipeline_id}&rightPipelineId={pipeline_id}",
    )
    assert isinstance(compare.get("files"), list)
    assert compare.get("summary", {}).get("total", 0) >= 1

    mr = api_post(
        user_b,
        f"{base_url}/api/projects/{project_id}/pipelines/{pipeline_id}/merge-requests",
        {
            "sourceCommitId": commit_id,
            "sourceBranchId": branch_id,
            "linkedWorkItemId": work_item_id,
            "title": "MR-1",
        },
        expected_status=201,
    )
    merge_request_id = mr["id"]

    approve = api_post(
        admin,
        f"{base_url}/api/projects/{project_id}/merge-requests/{merge_request_id}/approve",
        {},
    )
    assert approve["success"] is True

    merge = api_post(
        admin,
        f"{base_url}/api/projects/{project_id}/merge-requests/{merge_request_id}/merge",
        {},
    )
    assert merge["success"] is True
    work_items = api_get(user_b, f"{base_url}/api/projects/{project_id}/work-items")
    linked_item = next((item for item in work_items if item.get("id") == work_item_id), None)
    assert linked_item
    assert linked_item.get("state") == "done"

    forbidden_response = user_c.get(f"{base_url}/api/projects/{project_id}", timeout=20)
    assert forbidden_response.status_code == 403, forbidden_response.text

    admin_job = api_post(
        admin,
        f"{base_url}/api/jobs",
        {"googleDocTitle": "Admin private pipeline", "status": "pending"},
    )
    admin_job_id = admin_job["id"]
    forbidden_attach = user_b.post(
        f"{base_url}/api/projects/{project_id}/pipelines",
        json={"name": "Invalid attach", "baseJobId": admin_job_id},
        timeout=20,
    )
    assert forbidden_attach.status_code == 403, forbidden_attach.text


def test_job_creation_attaches_project(base_url: str) -> None:
    session = requests.Session()
    login_admin(session, base_url)
    created = api_post(
        session,
        f"{base_url}/api/jobs",
        {"googleDocTitle": "Test Job", "status": "pending"},
    )
    assert created.get("projectId")


def test_project_creation_requires_repo(base_url: str) -> None:
    session = requests.Session()
    login_admin(session, base_url)
    response = session.post(
        f"{base_url}/api/projects",
        json={"name": "Missing Repo Project", "gitRepo": ""},
        timeout=20,
    )
    assert response.status_code == 400, response.text


def test_project_edit_and_delete_owner_flow(base_url: str) -> None:
    owner = requests.Session()
    login_admin(owner, base_url)
    created = api_post(
        owner,
        f"{base_url}/api/projects",
        {"name": "Editable Project", "gitRepo": "octocat/editable-project", "gitDefaultBranch": "main"},
        expected_status=201,
    )
    project_id = created["id"]

    patched_response = owner.patch(
        f"{base_url}/api/projects/{project_id}",
        json={
            "name": "Editable Project V2",
            "gitRepo": "octocat/editable-project-v2",
            "gitDefaultBranch": "develop",
        },
        timeout=20,
    )
    assert patched_response.status_code == 200, patched_response.text

    project = api_get(owner, f"{base_url}/api/projects/{project_id}")
    assert project.get("name") == "Editable Project V2"
    assert project.get("gitRepo") == "octocat/editable-project-v2"
    assert project.get("gitDefaultBranch") == "develop"

    delete_response = owner.delete(f"{base_url}/api/projects/{project_id}", timeout=20)
    assert delete_response.status_code == 200, delete_response.text
    deleted_payload = delete_response.json()
    assert deleted_payload.get("success") is True

    fetch_deleted = owner.get(f"{base_url}/api/projects/{project_id}", timeout=20)
    assert fetch_deleted.status_code == 404, fetch_deleted.text

    personal = api_get(owner, f"{base_url}/api/projects")
    personal_project = next((item for item in personal if item.get("isPersonal") is True), None)
    assert personal_project, "Personal project must exist."
    personal_delete = owner.delete(f"{base_url}/api/projects/{personal_project['id']}", timeout=20)
    assert personal_delete.status_code == 400, personal_delete.text
