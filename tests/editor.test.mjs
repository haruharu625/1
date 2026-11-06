import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('video editor: upload, preview, trim, join, mute and Japanese subtitles', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'video-editor-test-'));
  const port = 32_000 + Math.floor(Math.random() * 10_000);
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => { logs += chunk; });
  server.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([
        new Promise(resolve => server.once('exit', resolve)),
        wait(3_000).then(() => server.kill('SIGKILL')),
      ]);
    }
    await rm(directory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited before readiness: ${logs}`);
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok && (await response.json()).ok) { ready = true; break; }
    } catch { /* Server is still starting. */ }
    await wait(100);
  }
  assert.ok(ready, `Server did not become ready: ${logs}`);

  const firstPath = join(directory, 'red.mp4');
  const secondPath = join(directory, 'blue.mp4');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=red:s=320x180:r=30:d=1.5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.4',
    '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', firstPath]);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=blue:s=320x180:r=30:d=1.5', '-c:v', 'libx264', '-threads', '1',
    '-pix_fmt', 'yuv420p', secondPath]);
  const upload = async (path, name) => {
    const response = await fetch(`${base}/api/videos?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await readFile(path),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  let first;
  let second;

  await t.test('uploads expose metadata, JPEG thumbnails and byte-range video playback', async () => {
    first = await upload(firstPath, '赤い動画.mp4');
    second = await upload(secondPath, '青い動画.mp4');
    assert.equal(first.name, '赤い動画.mp4');
    assert.equal(first.width, 320);
    assert.equal(first.height, 180);
    assert.equal(first.hasAudio, true);
    assert.equal(second.hasAudio, false);
    assert.ok(Math.abs(first.duration - 1.5) < 0.1);
    const media = await fetch(base + first.url, { headers: { Range: 'bytes=0-15' } });
    assert.equal(media.status, 206);
    assert.match(media.headers.get('content-range'), /^bytes 0-15\//);
    assert.equal((await media.arrayBuffer()).byteLength, 16);
    const thumbnail = await fetch(base + first.thumbnailUrl);
    assert.equal(thumbnail.status, 200);
    assert.match(thumbnail.headers.get('content-type'), /^image\/jpeg/);
    assert.deepEqual([...new Uint8Array(await thumbnail.arrayBuffer()).slice(0, 2)], [255, 216]);
  });

  await t.test('rejects invalid edits and missing media without starting export', async () => {
    const response = await fetch(`${base}/api/exports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: [{ videoId: first.id, start: 1.2, end: 0.5, volume: 1 }], texts: [] }),
    });
    assert.ok([400, 422].includes(response.status), await response.text());
    const missing = await fetch(`${base}/api/videos/00000000-0000-4000-8000-000000000000/media`);
    assert.equal(missing.status, 404);
  });

  await t.test('pads audio to the trim duration when source audio ended before the cut', async () => {
    const request = await fetch(`${base}/api/exports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips: [{ videoId: first.id, start: 0.6, end: 1.3, volume: 1 }], texts: [] }),
    });
    assert.equal(request.status, 202, await request.clone().text());
    const job = await request.json();
    let status;
    for (let attempt = 0; attempt < 300; attempt++) {
      status = await (await fetch(`${base}/api/exports/${job.id}`)).json();
      if (status.status === 'completed' || status.status === 'failed') break;
      await wait(150);
    }
    assert.equal(status.status, 'completed', JSON.stringify(status));
    const output = join(directory, 'short-audio.mp4');
    const download = await fetch(base + status.downloadUrl);
    assert.equal(download.status, 200);
    await writeFile(output, new Uint8Array(await download.arrayBuffer()));
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).stdout);
    assert.ok(Math.abs(Number(probe.format.duration) - 0.7) < 0.1, probe.format.duration);
    const audioStream = probe.streams.find(stream => stream.codec_type === 'audio');
    assert.ok(audioStream, 'Export should include padded audio even after the source audio ended');
    assert.ok(Math.abs(Number(audioStream.duration) - 0.7) < 0.1, audioStream.duration);
    const audio = await exec('ffmpeg', ['-hide_banner', '-i', output, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
    const maximum = audio.stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
    assert.ok(maximum && Number(maximum[1]) <= -75, 'Padding after the source audio ends should be silent');
  });

  await t.test('exports trimmed clips in order with silent audio and rendered Japanese text', async () => {
    const request = await fetch(`${base}/api/exports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clips: [first, second].map(video => ({ videoId: video.id, start: 0.25, end: 1.25, volume: 0 })),
        texts: [
          { text: "日本語 '引用': 50% , [字幕]\n２行目", start: 0, end: 2 },
          { text: '重なる字幕', start: 0.2, end: 1.8 },
        ],
      }),
    });
    assert.ok([200, 202].includes(request.status), await request.clone().text());
    const job = await request.json();
    assert.ok(job.id);
    let status;
    for (let attempt = 0; attempt < 300; attempt++) {
      const response = await fetch(`${base}/api/exports/${job.id}`);
      assert.equal(response.status, 200);
      status = await response.json();
      if (status.status === 'completed' || status.status === 'failed') break;
      await wait(150);
    }
    assert.equal(status.status, 'completed', JSON.stringify(status));
    assert.ok(status.downloadUrl);
    const download = await fetch(base + status.downloadUrl);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /^video\/mp4/);
    const output = join(directory, 'edited.mp4');
    await writeFile(output, new Uint8Array(await download.arrayBuffer()));
    const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).stdout);
    assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.15, probe.format.duration);
    const video = probe.streams.find(stream => stream.codec_type === 'video');
    assert.equal(video.codec_name, 'h264');
    assert.equal(video.width, 320);
    assert.equal(video.height, 180);
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
    const frame = async at => (await exec('ffmpeg', ['-v', 'error', '-ss', String(at), '-i', output,
      '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1_000_000 })).stdout;
    const red = await frame(0.4);
    const blue = await frame(1.4);
    const backgroundPixel = (30 * 320 + 160) * 3;
    assert.ok(red[backgroundPixel] > 180 && red[backgroundPixel + 2] < 70, 'First clip should remain red');
    assert.ok(blue[backgroundPixel + 2] > 180 && blue[backgroundPixel] < 70, 'Second clip should remain blue');
    let whitePixels = 0;
    for (let index = 0; index < red.length; index += 3) {
      if (red[index] > 190 && red[index + 1] > 190 && red[index + 2] > 190) whitePixels++;
    }
    assert.ok(whitePixels > 30, 'Subtitle glyphs should be visible in the exported video');
    const audio = await exec('ffmpeg', ['-hide_banner', '-i', output, '-af', 'volumedetect', '-vn', '-f', 'null', '-']);
    const maximum = audio.stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
    assert.ok(maximum && Number(maximum[1]) <= -75, 'Both exported clips should be muted');
  });
});
