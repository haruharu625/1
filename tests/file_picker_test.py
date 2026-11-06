"""Optional browser regression: real pointer/keyboard file chooser activation.

Requires Python Playwright and Chromium; starts its own temporary Node server.
Run: python3 tests/file_picker_test.py
"""

import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import unittest
from urllib.request import urlopen

from playwright.sync_api import Error as PlaywrightError, expect, sync_playwright


ROOT = Path(__file__).resolve().parent.parent
PICKERS = (
    ("中央の動画を選択", "#main-upload"),
    ("ライブラリの動画を追加", "#library-upload"),
    ("タイムライン上部の動画を追加", "#timeline-add"),
    ("空タイムラインの追加欄", "#video-track .file-picker"),
)


class FilePickerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="frame-picker-test-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.directory = Path(cls.temporary.name)
        cls.fixture = cls.directory / "選択テスト.mp4"
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "color=c=teal:s=320x180:r=30:d=0.6", "-c:v", "libx264", "-threads", "1",
            "-pix_fmt", "yuv420p", str(cls.fixture),
        ], check=True, timeout=20)

        log_path = cls.directory / "server.log"
        cls.log = log_path.open("w")
        cls.addClassCleanup(cls.log.close)
        cls.server = subprocess.Popen(
            ["node", "server.mjs"], cwd=ROOT,
            env={**os.environ, "HOST": "127.0.0.1", "PORT": "0"},
            stdout=cls.log, stderr=subprocess.STDOUT,
        )
        cls.addClassCleanup(cls.stop_server)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            output = log_path.read_text()
            match = re.search(r"running on port (\d+)", output)
            if match:
                cls.base = f"http://127.0.0.1:{match[1]}"
                with urlopen(cls.base + "/api/health", timeout=2) as response:
                    if response.status == 200:
                        break
            if cls.server.poll() is not None:
                raise RuntimeError(f"Test server exited: {output}")
            time.sleep(0.05)
        else:
            raise RuntimeError(f"Test server was not ready: {log_path.read_text()}")

        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        cls.browser = cls.playwright.chromium.launch(
            executable_path=os.environ.get("CHROMIUM_PATH", "/usr/bin/chromium"),
            headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        cls.addClassCleanup(cls.browser.close)

    @classmethod
    def stop_server(cls):
        if cls.server.poll() is None:
            cls.server.terminate()
            try:
                cls.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                cls.server.kill()
                cls.server.wait(timeout=2)

    def page(self, **options):
        context = self.browser.new_context(viewport={"width": 1440, "height": 1000}, **options)
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(10_000)
        return page

    def open_ready(self, page):
        response = page.goto(self.base)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers.get("cache-control"), "no-store")
        expect(page.locator("#app-startup-status")).to_be_hidden()
        expect(page.locator("#file-input")).to_be_enabled()

    def choose_by_mouse(self, page, surface):
        control = page.locator(surface)
        with page.expect_file_chooser() as event:
            # Locator.click dispatches real pointer events after checking layout and hit testing.
            # Do not replace this with set_input_files: that bypasses chooser activation.
            control.locator(".video-file-input").click()
        chooser = event.value
        self.assertTrue(chooser.is_multiple())
        chooser.set_files(str(self.fixture))

    def expect_uploaded(self, page):
        expect(page.locator("#video-track .clip")).to_have_count(1)
        expect(page.locator("#selected-name")).to_have_text(self.fixture.name)
        expect(page.locator("#clip-count")).to_have_text("1")
        expect(page.locator("#export-button")).to_be_enabled()

    def test_desktop_mouse_opens_all_four_choosers_and_uploads(self):
        for label, selector in PICKERS:
            with self.subTest(surface=label):
                page = self.page()
                errors = []
                page.on("pageerror", lambda error: errors.append(str(error)))
                self.open_ready(page)
                self.choose_by_mouse(page, selector)
                self.expect_uploaded(page)
                self.assertEqual(errors, [])
                page.close()

    def test_keyboard_space_opens_main_chooser(self):
        page = self.page()
        self.open_ready(page)
        page.locator("#file-input").focus()
        expect(page.locator("#file-input")).to_be_focused()
        with page.expect_file_chooser() as event:
            page.keyboard.press("Space")
        self.assertTrue(event.value.is_multiple())
        event.value.set_files(str(self.fixture))
        self.expect_uploaded(page)

    def test_missing_app_script_keeps_startup_message_and_pickers_disabled(self):
        page = self.page()
        page.route("**/app.js", lambda route: route.abort())
        page.goto(self.base)
        expect(page.locator("#app-startup-status")).to_be_visible()
        expect(page.locator("#app-startup-status")).to_contain_text("ページを再読み込み")
        expect(page.locator(".video-file-input")).to_have_count(4)
        for control in page.locator(".video-file-input").all():
            expect(control).to_be_disabled()
        expect(page.locator("#export-button")).to_be_disabled()

    def test_saved_html_keeps_explanation_visible_instead_of_inert_chooser(self):
        page = self.page()
        try:
            page.goto((ROOT / "public" / "index.html").as_uri())
        except PlaywrightError as error:
            if "ERR_BLOCKED_BY_ADMINISTRATOR" in str(error):
                self.skipTest("Managed Chromium policy blocks file:// navigation")
            raise
        expect(page.locator("#app-startup-status")).to_be_visible()
        expect(page.locator("#app-startup-status")).to_contain_text("HTML")
        for control in page.locator(".video-file-input").all():
            expect(control).to_be_disabled()
        expect(page.locator("#export-button")).to_be_disabled()

    def test_upload_works_when_random_uuid_is_unavailable(self):
        page = self.page()
        page.add_init_script("Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });")
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        self.open_ready(page)
        self.assertEqual(page.evaluate("typeof crypto.randomUUID"), "undefined")
        self.choose_by_mouse(page, "#main-upload")
        self.expect_uploaded(page)
        self.assertEqual(errors, [])

    def test_mobile_touch_opens_main_chooser(self):
        context = self.browser.new_context(
            viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
        )
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(10_000)
        self.open_ready(page)
        control = page.locator("#main-upload")
        control.scroll_into_view_if_needed()
        bounds = control.bounding_box()
        self.assertIsNotNone(bounds)
        with page.expect_file_chooser() as event:
            page.touchscreen.tap(bounds["x"] + bounds["width"] / 2, bounds["y"] + bounds["height"] / 2)
        self.assertTrue(event.value.is_multiple())
        event.value.set_files(str(self.fixture))
        self.expect_uploaded(page)


if __name__ == "__main__":
    unittest.main(verbosity=2)
