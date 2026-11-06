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
const sampleRate = 48_000;

function rms(samples, start, end) {
  let squared = 0;
  const first = Math.round(start * sampleRate);
  const last = Math.round(end * sampleRate);
  assert.ok(last <= samples.length, 'Exported audio must cover the measured time range');
  for (let index = first; index < last; index++) squared += samples[index] ** 2;
  return Math.sqrt(squared / (last - first));
}

function amplitude(samples, frequency, start, end) {
  let real = 0;
  let imaginary = 0;
  const first = Math.round(start * sampleRate);
  const last = Math.round(end * sampleRate);
  for (let index = first; index < last; index++) {
    const angle = 2 * Math.PI * frequency * index / sampleRate;
    real += samples[index] * Math.cos(angle);
    imaginary += samples[index] * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / (last - first);
}

test('audio tracks: upload, source trim, timeline offset, volume and original-audio mixing', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'frame-audio-test-'));
  let logs = '';
  let port;
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: root,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', chunk => {
    logs += chunk;
    const match = logs.match(/running on port (\d+)/);
    if (match) port = Number(match[1]);
  });
  server.stderr.on('data', chunk => { logs += chunk; });
  t.after(async () => {
    if (server.exitCode === null) {
      const closed = new Promise(resolve => server.once('close', resolve));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 3_000);
      await closed;
      clearTimeout(force);
    }
    await rm(directory, { recursive: true, force: true });
  });
  let base;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Server exited before readiness: ${logs}`);
    if (port) {
      base = `http://127.0.0.1:${port}`;
      try {
        const response = await fetch(`${base}/api/health`);
        if (response.ok && (await response.json()).ok) break;
      } catch { /* The server is still starting. */ }
    }
    await wait(100);
  }
  assert.ok(base, `Server did not announce its listening port: ${logs}`);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);

  const silentPath = join(directory, 'silent.mp4');
  const originalPath = join(directory, 'original-audio.mp4');
  const audioPath = join(directory, 'two-tones.wav');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'color=c=teal:s=320x180:r=30:d=3', '-an', '-c:v', 'libx264', '-threads', '1',
    '-pix_fmt', 'yuv420p', silentPath]);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', silentPath, '-f', 'lavfi', '-i',
    'sine=frequency=220:sample_rate=48000:duration=3', '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-t', '3', originalPath]);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000:duration=1', '-f', 'lavfi', '-i',
    'sine=frequency=880:sample_rate=48000:duration=1', '-filter_complex',
    '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]', '-c:a', 'pcm_s16le', audioPath]);

  const upload = async (kind, file, name) => {
    const response = await fetch(`${base}/api/${kind}?name=${encodeURIComponent(name)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await readFile(file),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const silent = await upload('videos', silentPath, '無音の動画.mp4');
  const original = await upload('videos', originalPath, '元の音声つき動画.mp4');
  let audio;
  await t.test('uploads audio metadata and supports byte-range playback', async () => {
    audio = await upload('audios', audioPath, '効果音とBGM.wav');
    assert.ok(audio.id);
    assert.equal(audio.name, '効果音とBGM.wav');
    assert.ok(Math.abs(audio.duration - 2) < 0.05, `Source duration: ${audio.duration}`);
    const response = await fetch(base + audio.url, { headers: { Range: 'bytes=0-15' } });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-range'), /^bytes 0-15\//);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, 16);
    assert.equal(bytes.subarray(0, 4).toString(), 'RIFF');
  });
  assert.ok(audio, 'Audio upload must succeed before export checks');

  const clip = (video, volume = 1) => ({ videoId: video.id, start: 0, end: 3, volume });
  const track = overrides => ({ audioId: audio.id, start: 1, end: 2, offset: 0.75, volume: 1, ...overrides });
  const exportAudio = async (name, clips, audioTracks, texts = []) => {
    const response = await fetch(`${base}/api/exports`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clips, texts, audioTracks }),
    });
    assert.equal(response.status, 202, await response.clone().text());
    const job = await response.json();
    let status;
    for (let attempt = 0; attempt < 300; attempt++) {
      const poll = await fetch(`${base}/api/exports/${job.id}`);
      assert.equal(poll.status, 200);
      status = await poll.json();
      if (['completed', 'failed'].includes(status.status)) break;
      await wait(100);
    }
    assert.equal(status?.status, 'completed', JSON.stringify(status));
    const download = await fetch(base + status.downloadUrl);
    assert.equal(download.status, 200);
    const output = join(directory, `${name}.mp4`);
    await writeFile(output, Buffer.from(await download.arrayBuffer()));
    const probe = JSON.parse((await exec('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', output,
    ])).stdout);
    assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.15, `Video duration: ${probe.format.duration}`);
    assert.ok(probe.streams.some(stream => stream.codec_type === 'video' && stream.codec_name === 'h264'));
    assert.ok(probe.streams.some(stream => stream.codec_type === 'audio' && stream.codec_name === 'aac'));
    const decoded = (await exec('ffmpeg', ['-v', 'error', '-i', output, '-vn', '-ac', '1',
      '-ar', String(sampleRate), '-f', 'f32le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 3_000_000 })).stdout;
    return new Float32Array(decoded.buffer.slice(decoded.byteOffset, decoded.byteOffset + decoded.byteLength));
  };
  let fullAmplitude;
  await t.test('places only the trimmed source segment at its timeline offset, with silence before and after', async () => {
    const samples = await exportAudio('offset', [clip(silent)], [track()]);
    assert.ok(rms(samples, 0.15, 0.5) < 0.0002, 'Audio before the timeline offset should be silent');
    assert.ok(rms(samples, 1, 1.3) > 0.03, 'The BGM should be audible after its timeline offset');
    assert.ok(rms(samples, 2.1, 2.5) < 0.0002, 'Audio after the trimmed segment should be silent');
    fullAmplitude = amplitude(samples, 880, 1, 1.3);
    assert.ok(fullAmplitude > 0.03, 'Source start=1 should select the second, 880Hz tone');
    assert.ok(fullAmplitude > amplitude(samples, 440, 1, 1.3) * 20, 'The unselected first source segment must not play');
  });
  await t.test('applies BGM volume independently while the original video audio is muted', async () => {
    const samples = await exportAudio('half-volume', [clip(original, 0)], [track({ volume: 0.5 })]);
    const halfAmplitude = amplitude(samples, 880, 1, 1.3);
    assert.ok(fullAmplitude > 0, 'The full-volume reference must be measured');
    assert.ok(Math.abs(halfAmplitude / fullAmplitude - 0.5) < 0.1,
      `Expected half amplitude, got ${halfAmplitude / fullAmplitude}`);
    assert.ok(halfAmplitude > amplitude(samples, 220, 1, 1.3) * 20, 'Muted original audio must not leak into the BGM');
    assert.ok(rms(samples, 0.15, 0.5) < 0.0002, 'Muting original audio must also silence it before BGM starts');
  });
  await t.test('mixes original video audio with an added audio track while rendering subtitles', async () => {
    const samples = await exportAudio('mixed', [clip(original)], [track()], [
      { text: 'BGMと字幕', start: 0, end: 1 },
    ]);
    assert.ok(amplitude(samples, 220, 1, 1.3) > 0.03, 'Original video audio should remain audible');
    assert.ok(amplitude(samples, 880, 1, 1.3) > 0.03, 'Added audio should be audible alongside original audio');
  });
  await t.test('mixes overlapping added tracks instead of replacing an earlier track', async () => {
    const samples = await exportAudio('overlapping-tracks', [clip(silent)], [
      track({ start: 0, end: 0.75, offset: 0.5 }),
      track({ start: 1, end: 1.75, offset: 0.5 }),
    ]);
    assert.ok(amplitude(samples, 440, 0.75, 1.05) > 0.03, 'The first added audio track should remain audible');
    assert.ok(amplitude(samples, 880, 0.75, 1.05) > 0.03, 'The second added audio track should also be audible');
  });
  await t.test('trims added audio at the project end without extending the MP4', async () => {
    const samples = await exportAudio('project-end', [clip(silent)], [track({ start: 0, end: 2, offset: 2.5 })]);
    assert.ok(rms(samples, 2, 2.3) < 0.0002, 'Late audio should not start early');
    assert.ok(rms(samples, 2.65, 2.9) > 0.03, 'Audio should remain audible through the end of the project');
  });
  await t.test('rejects invalid audio inputs and track ranges before starting an export', async () => {
    for (const body of [Buffer.alloc(0), Buffer.from('This is not an audio file')]) {
      const response = await fetch(`${base}/api/audios?name=invalid.wav`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body,
      });
      assert.ok([400, 422].includes(response.status), await response.text());
    }
    const noAudio = await fetch(`${base}/api/audios?name=silent.mp4`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: await readFile(silentPath),
    });
    assert.equal(noAudio.status, 422, await noAudio.text());
    const invalid = [
      [track({ start: -0.1 })], [track({ end: 1 })], [track({ end: 2.5 })],
      [track({ offset: -0.1 })], [track({ offset: 3 })],
      [track({ volume: -0.1 })], [track({ volume: 1.1 })],
      [track({ start: audio.duration + 0.0002, end: audio.duration + 0.0007 })],
      [track({ start: null })], [track({ audioId: '00000000-0000-4000-8000-000000000000' })],
      Array.from({ length: 9 }, () => track()), {},
    ];
    for (const audioTracks of invalid) {
      const response = await fetch(`${base}/api/exports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clips: [clip(silent)], texts: [], audioTracks }),
      });
      assert.ok([400, 404].includes(response.status),
        `Invalid audioTracks accepted: ${JSON.stringify(audioTracks)}; ${await response.text()}`);
    }
  });
});
