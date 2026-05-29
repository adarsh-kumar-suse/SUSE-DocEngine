import time

import requests
from playwright.sync_api import Page, expect


def login_with_admin(page: Page, base_url: str) -> None:
  page.goto(f"{base_url}/login", wait_until="networkidle")
  page.get_by_role("button", name="Email & Password").click()
  page.get_by_placeholder("Email or username").fill("admin")
  page.get_by_placeholder("Password").fill("admin123")
  page.locator("form button[type='submit']").click()
  expect(page).to_have_url(f"{base_url}/")
  expect(page.get_by_role("heading", name="Documentation Pipeline")).to_be_visible()


def test_health_endpoint_is_available(base_url: str) -> None:
  response = requests.get(f"{base_url}/api/health", timeout=5)
  assert response.status_code == 200
  payload = response.json()
  assert payload["status"] == "ok"


def test_login_page_loads(page: Page, base_url: str) -> None:
  page.goto(f"{base_url}/login", wait_until="networkidle")
  expect(page.get_by_role("heading", name="SUSE DocEngine")).to_be_visible()
  expect(page.get_by_role("button", name="Sign in with Google")).to_be_visible()


def test_admin_login_dashboard_does_not_reload_loop(page: Page, base_url: str) -> None:
  navigations: list[str] = []

  def on_navigated(frame) -> None:
    if frame == page.main_frame:
      navigations.append(frame.url)

  page.on("framenavigated", on_navigated)
  login_with_admin(page, base_url)
  time.sleep(3)
  assert page.url == f"{base_url}/"
  assert len(navigations) <= 8


def test_session_persists_after_refresh(page: Page, base_url: str) -> None:
  login_with_admin(page, base_url)
  page.reload(wait_until="networkidle")
  expect(page.get_by_role("heading", name="Documentation Pipeline")).to_be_visible()
