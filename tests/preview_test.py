"""Optional real-browser regression for fitting full video frames in the editor.

Run: python3 tests/preview_test.py
Uses the temporary local server/Chromium fixture from file_picker_test.py.
"""

from pathlib import Path
import subprocess
import unittest

from playwright.sync_api import expect

import file_picker_test as browser_fixture


VIEWPORTS = ((1366, 768), (1280, 720), (390, 844))
SOURCES = (("wide", 960, 540), ("square", 640, 640), ("portrait", 540, 960))


class PreviewTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.addClassCleanup(browser_fixture.FilePickerTest.doClassCleanups)
        browser_fixture.FilePickerTest.setUpClass()
        cls.browser = browser_fixture.FilePickerTest.browser
        cls.base = browser_fixture.FilePickerTest.base
        cls.files = []
        for name, width, height in SOURCES:
            filename = Path(browser_fixture.FilePickerTest.directory) / f"{name}.mp4"
            markers = ",".join((
                "drawbox=x=0:y=0:w=iw/5:h=ih/5:c=red:t=fill",
                "drawbox=x=iw*4/5:y=0:w=iw/5:h=ih/5:c=lime:t=fill",
                "drawbox=x=0:y=ih*4/5:w=iw/5:h=ih/5:c=blue:t=fill",
                "drawbox=x=iw*4/5:y=ih*4/5:w=iw/5:h=ih/5:c=yellow:t=fill",
            ))
            subprocess.run([
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                f"color=c=gray:s={width}x{height}:r=30:d=0.6", "-vf", markers,
                "-c:v", "libx264", "-threads", "1", "-pix_fmt", "yuv420p", str(filename),
            ], check=True, timeout=20)
            cls.files.append(str(filename))

    def open_project(self, viewport):
        width, height = viewport
        context = self.browser.new_context(viewport={"width": width, "height": height})
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(10_000)
        page.goto(self.base)
        expect(page.locator("#app-startup-status")).to_be_hidden()
        page.locator("#file-input").set_input_files(self.files)
        expect(page.locator("#video-track .clip")).to_have_count(len(SOURCES))
        expect(page.locator("#export-button")).to_be_enabled()
        return page

    def select_source(self, page, index):
        _, width, height = SOURCES[index]
        page.locator("#video-track .clip").nth(index).click()
        page.wait_for_function(
            "([width,height])=>{const v=document.getElementById('preview-video');"
            "return v.readyState>=2 && v.videoWidth===width && v.videoHeight===height;}",
            arg=[width, height],
        )
        if page.viewport_size["width"] > 900:
            page.evaluate("window.scrollTo(0,0)")
        else:
            page.locator("#preview-stage").scroll_into_view_if_needed()

    def frames(self, page, count):
        page.evaluate(
            "count=>new Promise(resolve=>{const next=()=>--count<=0?resolve():requestAnimationFrame(next);"
            "requestAnimationFrame(next);})", count,
        )

    def geometry(self, page):
        return page.evaluate("""() => {
          const rect = selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
          };
          const video = document.getElementById('preview-video');
          return {
            stage:rect('#preview-stage'), wrap:rect('#video-wrap'), video:rect('#preview-video'),
            transport:rect('.transport'), toolbar:rect('.timeline-toolbar'), track:rect('#video-track'),
            viewport:{width:innerWidth,height:innerHeight},
            documentWidth:document.documentElement.scrollWidth,
            natural:{width:video.videoWidth,height:video.videoHeight},
            fit:getComputedStyle(video).objectFit
          };
        }""")

    def stable_geometry(self, page):
        self.frames(page, 8)
        first = self.geometry(page)
        self.frames(page, 12)
        second = self.geometry(page)
        for element in ("stage", "wrap", "video"):
            for dimension in ("width", "height"):
                self.assertAlmostEqual(
                    first[element][dimension], second[element][dimension], delta=1,
                    msg=f"{element} {dimension} keeps changing without user input: {first} -> {second}",
                )
        return second

    def assert_fits(self, geometry):
        stage, wrap, video = (geometry[name] for name in ("stage", "wrap", "video"))
        viewport = geometry["viewport"]
        self.assertGreater(stage["width"], 50)
        self.assertGreater(stage["height"], 50)
        self.assertGreaterEqual(stage["y"], -1)
        self.assertLessEqual(stage["bottom"], viewport["height"] + 1, geometry)
        self.assertLessEqual(geometry["documentWidth"], viewport["width"] + 1, geometry)
        for contained in (wrap, video):
            self.assertGreaterEqual(contained["x"], stage["x"] - 1, geometry)
            self.assertGreaterEqual(contained["y"], stage["y"] - 1, geometry)
            self.assertLessEqual(contained["right"], stage["right"] + 1, geometry)
            self.assertLessEqual(contained["bottom"], stage["bottom"] + 1, geometry)
        ratio = geometry["natural"]["width"] / geometry["natural"]["height"]
        self.assertAlmostEqual(video["width"] / video["height"], ratio, delta=0.01, msg=str(geometry))
        self.assertAlmostEqual(wrap["width"] / wrap["height"], ratio, delta=0.01, msg=str(geometry))
        self.assertEqual(geometry["fit"], "contain")
        if viewport["width"] > 900:
            for element in ("transport", "toolbar", "track"):
                self.assertGreaterEqual(geometry[element]["y"], -1, geometry)
                self.assertLessEqual(geometry[element]["bottom"], viewport["height"] + 1, geometry)

    def assert_corners_visible(self, page):
        png = page.locator("#video-wrap").screenshot()
        # Decode the browser screenshot, using existing FFmpeg rather than another Python dependency.
        rgb = subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-vf", "scale=100:100",
            "-frames:v", "1", "-threads", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
        ], input=png, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=10).stdout
        self.assertEqual(len(rgb), 100 * 100 * 3)
        pixel = lambda x, y: rgb[(y * 100 + x) * 3:(y * 100 + x) * 3 + 3]
        red, green, blue, yellow = (pixel(x, y) for x, y in ((10, 10), (90, 10), (10, 90), (90, 90)))
        self.assertTrue(red[0] > 170 and red[1] < 90 and red[2] < 90, f"Top-left corner clipped: {list(red)}")
        self.assertTrue(green[1] > 170 and green[0] < 90 and green[2] < 90, f"Top-right corner clipped: {list(green)}")
        self.assertTrue(blue[2] > 170 and blue[0] < 90 and blue[1] < 90, f"Bottom-left corner clipped: {list(blue)}")
        self.assertTrue(yellow[0] > 170 and yellow[1] > 170 and yellow[2] < 90, f"Bottom-right corner clipped: {list(yellow)}")

    def test_full_frames_and_controls_fit_at_desktop_and_mobile_sizes(self):
        for viewport in VIEWPORTS:
            page = self.open_project(viewport)
            for index, (name, _, _) in enumerate(SOURCES):
                with self.subTest(viewport=viewport, source=name):
                    self.select_source(page, index)
                    self.assert_fits(self.stable_geometry(page))
                    self.assert_corners_visible(page)
                    if viewport[0] <= 900:
                        # A narrow layout scrolls vertically; both editing controls remain reachable.
                        for selector in ("#play-button", "#video-track"):
                            target = page.locator(selector)
                            target.scroll_into_view_if_needed()
                            bounds = target.bounding_box()
                            self.assertGreaterEqual(bounds["y"], -1)
                            self.assertLessEqual(bounds["y"] + bounds["height"], viewport[1] + 1)
                        expect(page.locator("#play-button")).to_be_enabled()
            page.close()

    def test_repeated_resizes_and_source_switches_do_not_grow_preview(self):
        page = self.open_project(VIEWPORTS[0])
        previous = {}
        for viewport in (VIEWPORTS[0], VIEWPORTS[1], VIEWPORTS[2], VIEWPORTS[1], VIEWPORTS[0], VIEWPORTS[1]):
            page.set_viewport_size({"width": viewport[0], "height": viewport[1]})
            for index in (2, 1, 0):
                key = (viewport, index)
                self.select_source(page, index)
                geometry = self.stable_geometry(page)
                self.assert_fits(geometry)
                size = tuple(geometry[element][dimension] for element in ("stage", "wrap") for dimension in ("width", "height"))
                if key in previous:
                    for before, after in zip(previous[key], size):
                        self.assertAlmostEqual(before, after, delta=1, msg=f"Preview size drift after resize/source switch: {key}")
                previous[key] = size


if __name__ == "__main__":
    unittest.main(verbosity=2)
