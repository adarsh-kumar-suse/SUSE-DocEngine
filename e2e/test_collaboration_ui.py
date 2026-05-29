import requests
from playwright.sync_api import Browser, Page, expect


def api_post(session: requests.Session, url: str, payload: dict, expected_status: int = 200) -> dict:
    response = session.post(url, json=payload, timeout=20)
    assert response.status_code == expected_status, response.text
    return response.json() if response.text else {}


def api_get(session: requests.Session, url: str, expected_status: int = 200):
    response = session.get(url, timeout=20)
    assert response.status_code == expected_status, response.text
    return response.json() if response.text else {}


def login_ui(page: Page, base_url: str, identifier: str, password: str, invite_token: str | None = None) -> None:
    login_url = f"{base_url}/login"
    if invite_token:
        login_url = f"{login_url}?invite={invite_token}"
    page.goto(login_url, wait_until="networkidle")
    page.get_by_role("button", name="Email & Password").click()
    page.get_by_placeholder("Email or username").fill(identifier)
    page.get_by_placeholder("Password").fill(password)
    page.locator("form button[type='submit']").click()
    expect(page).to_have_url(f"{base_url}/")


def test_two_user_collaboration_flow_ui(browser: Browser, base_url: str) -> None:
    admin_api = requests.Session()
    user_b_api = requests.Session()

    api_post(admin_api, f"{base_url}/api/auth/login", {"identifier": "admin", "password": "admin123"})
    signup_payload = {
        "email": "ui-collab-b@local",
        "username": "ui_collab_b",
        "displayName": "UI Collaborator B",
        "password": "collab123",
    }
    signup_response = user_b_api.post(f"{base_url}/api/auth/signup", json=signup_payload, timeout=20)
    if signup_response.status_code not in (201, 409):
        raise AssertionError(signup_response.text)
    if signup_response.status_code == 409:
        api_post(user_b_api, f"{base_url}/api/auth/login", {"identifier": "ui_collab_b", "password": "collab123"})

    context_a = browser.new_context()
    context_b = browser.new_context()
    page_a = context_a.new_page()
    page_b = context_b.new_page()

    api_post(admin_api, f"{base_url}/api/jobs", {"googleDocTitle": "Admin Existing Pipeline", "status": "pending"})

    login_ui(page_a, base_url, "admin", "admin123")
    page_a.goto(f"{base_url}/projects-owned", wait_until="networkidle")
    page_a.get_by_role("button", name="Add Project").first.click()
    page_a.get_by_placeholder("Project name").fill("UI Collab Project")
    page_a.get_by_placeholder("owner/repo (required)").fill("octocat/ui-collab-project")
    page_a.get_by_role("button", name="Create Project").click()
    expect(page_a.get_by_text("Project created.")).to_be_visible()

    projects = api_get(admin_api, f"{base_url}/api/projects")
    project = next((p for p in projects if p.get("name") == "UI Collab Project"), None)
    assert project, "Project created via UI was not found in API list."
    project_id = project["id"]

    api_post(
        admin_api,
        f"{base_url}/api/projects/{project_id}/invites",
        {"email": "ui-collab-b@local", "role": "editor"},
        expected_status=201,
    )
    invites = api_get(admin_api, f"{base_url}/api/projects/{project_id}/invites")
    pending_invite = next((invite for invite in invites if invite.get("email") == "ui-collab-b@local"), None)
    assert pending_invite, "Invite token not found."

    login_ui(page_b, base_url, "ui_collab_b", "collab123", pending_invite["token"])
    api_post(user_b_api, f"{base_url}/api/jobs", {"googleDocTitle": "Collaborator Existing Pipeline", "status": "pending"})
    page_b.evaluate(
        """(projectId) => {
          localStorage.setItem('active_project_id', projectId);
          window.dispatchEvent(new CustomEvent('active-project-changed', { detail: { projectId } }));
        }""",
        project_id,
    )
    page_b.goto(f"{base_url}/projects-shared", wait_until="networkidle")
    expect(page_b.get_by_role("heading", name="Shared Projects")).to_be_visible()
    page_b.locator("tr", has_text="UI Collab Project").first.get_by_role("button", name="Open").click()
    expect(page_b.get_by_text("Shared project authority:")).to_be_visible()

    page_a.evaluate(
        """(projectId) => {
          localStorage.setItem('active_project_id', projectId);
          window.dispatchEvent(new CustomEvent('active-project-changed', { detail: { projectId } }));
        }""",
        project_id,
    )
    page_a.goto(f"{base_url}/projects-owned", wait_until="networkidle")
    page_a.locator("tr", has_text="UI Collab Project").first.get_by_role("button", name="Open").click()
    page_a.get_by_role("button", name="Refresh").click()
    attach_button = page_a.get_by_role("button", name="Attach Pipeline")
    if attach_button.is_enabled():
        attach_button.click()
        expect(page_a.get_by_text("Pipeline attached to project.")).to_be_visible()
    else:
        expect(page_a.get_by_text("No pipeline available. Create pipeline first from New Pipeline.")).to_be_visible()
        api_post(
            admin_api,
            f"{base_url}/api/projects/{project_id}/pipelines",
            {"name": "Fallback Pipeline", "initialContent": {"adoc": "= Title"}},
            expected_status=201,
        )
        page_a.get_by_role("button", name="Refresh").click()
    expect(page_a.get_by_text("Attached Pipelines")).to_be_visible()
    expect(page_a.get_by_role("heading", name="Collaborators")).to_be_visible()

    context_a.close()
    context_b.close()
