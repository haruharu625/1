"""Real browser regression for adding, previewing and exporting a BGM track."""
import json
from pathlib import Path
import subprocess
import unittest

from playwright.sync_api import expect

import file_picker_test as browser_fixture


class AudioBrowserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.addClassCleanup(browser_fixture.FilePickerTest.doClassCleanups)
        browser_fixture.FilePickerTest.setUpClass()
        cls.browser = browser_fixture.FilePickerTest.browser
        cls.base = browser_fixture.FilePickerTest.base
        directory = Path(browser_fixture.FilePickerTest.directory)
        cls.video = directory / '動画.mp4'
        cls.audio = directory / '音楽.wav'
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                        'testsrc2=s=640x360:r=30:d=3', '-c:v', 'libx264',
                        '-threads', '1', '-pix_fmt', 'yuv420p', str(cls.video)], check=True)
        subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i',
                        'sine=frequency=660:duration=4', str(cls.audio)], check=True)
        cls.directory = directory

    def page_with_video(self):
        context = self.browser.new_context(viewport={'width': 1366, 'height': 768}, accept_downloads=True)
        self.addCleanup(context.close)
        page = context.new_page()
        page.set_default_timeout(15_000)
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(self.base)
        expect(page.locator('#app-startup-status')).to_be_hidden()
        with page.expect_file_chooser() as event:
            page.locator('#file-input').click()
        event.value.set_files(str(self.video))
        expect(page.locator('#video-track .clip')).to_have_count(1)
        expect(page.locator('#export-button')).to_be_enabled()
        return page, errors

    def add_audio(self, page):
        page.locator('#audio-tab').click()
        with page.expect_file_chooser() as event:
            page.locator('.audio-file-input').click()
        event.value.set_files(str(self.audio))
        expect(page.locator('#audio-track .audio-block')).to_have_count(1)
        expect(page.locator('#audio-inspector')).to_be_visible()
        expect(page.locator('#export-button')).to_be_enabled()

    def test_add_trim_place_adjust_preview_and_export_bgm(self):
        page, errors = self.page_with_video()
        self.add_audio(page)
        self.assertEqual(page.locator('#audio-selected-name').inner_text(), self.audio.name)
        page.locator('#audio-trim-start').fill('0.1')
        page.locator('#audio-trim-start').press('Tab')
        page.wait_for_function("Math.abs(document.querySelector('audio').currentTime - 0.1) < 0.01")
        for control, value in [('audio-trim-start', '0.4'), ('audio-trim-end', '1.8'), ('audio-offset', '0.5')]:
            page.locator('#' + control).fill(value)
            page.locator('#' + control).press('Tab')
        page.locator('#audio-volume').fill('35')
        expect(page.locator('#audio-volume-value')).to_have_text('35%')
        page.locator('#go-start').click()
        page.locator('#play-button').click()
        page.wait_for_function("""() => {
            const audio = document.querySelector('audio.audio-preview-source');
            return audio && !audio.paused && audio.currentTime > 0.5 && audio.currentTime < 1.7;
        }""", timeout=10_000)
        self.assertAlmostEqual(page.locator('audio').evaluate('(audio) => audio.volume'), 0.35, delta=0.001)
        page.locator('#play-button').click()
        self.assertTrue(page.locator('audio').evaluate('(audio) => audio.paused'))
        page.locator('#audio-track .audio-block').click()
        page.locator('#audio-mute').click()
        self.assertEqual(page.locator('audio').evaluate('(audio) => audio.volume'), 0)
        page.locator('#audio-mute').click()
        page.locator('#audio-volume').fill('35')
        page.locator('#export-button').click()
        with page.expect_request(lambda request: request.method == 'POST' and request.url.endswith('/api/exports')) as request:
            page.locator('#start-export').click()
        data = request.value.post_data_json
        self.assertEqual(len(data['audioTracks']), 1)
        self.assertEqual({key: data['audioTracks'][0][key] for key in ['start', 'end', 'offset', 'volume']},
                         {'start': 0.4, 'end': 1.8, 'offset': 0.5, 'volume': 0.35})
        page.locator('#download-export').wait_for(state='visible', timeout=60_000)
        with page.expect_download() as download:
            page.locator('#download-export').click()
        output = self.directory / 'browser-bgm.mp4'
        download.value.save_as(output)
        metadata = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(output)]))
        self.assertTrue(any(stream['codec_type'] == 'audio' for stream in metadata['streams']))
        self.assertAlmostEqual(float(metadata['format']['duration']), 3, delta=0.15)
        self.assertEqual(errors, [])

    def test_removing_audio_and_shortening_video_remove_out_of_range_tracks(self):
        page, errors = self.page_with_video()
        self.add_audio(page)
        page.locator('#audio-offset').fill('2')
        page.locator('#audio-offset').press('Tab')
        page.locator('#video-track .clip').click()
        page.locator('#trim-end').fill('1')
        page.locator('#trim-end').press('Tab')
        expect(page.locator('#audio-track .audio-block')).to_have_count(0)
        expect(page.locator('audio')).to_have_count(0)
        page.locator('#audio-tab').click()
        page.locator('#audio-library .audio-asset').click()
        expect(page.locator('#audio-track .audio-block')).to_have_count(1)
        page.locator('#remove-audio').click()
        expect(page.locator('#audio-track .audio-block')).to_have_count(0)
        expect(page.locator('audio')).to_have_count(0)
        self.assertEqual(errors, [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
