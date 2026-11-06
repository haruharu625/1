import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, writeFile, stat, realpath, rm, access, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

const publicRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const dataRoot = await mkdtemp(path.join(tmpdir(), 'frame-editor-'));
const videos = new Map();
const jobs = new Map();
const children = new Set();
const maxUpload = 500 * 1024 * 1024;
const maxStorage = 2 * 1024 * 1024 * 1024;
const maxDuration = 4 * 60 * 60;
const ttl = 6 * 60 * 60 * 1000;
const font = await (async () => {
  for (const candidate of [path.join(path.dirname(fileURLToPath(import.meta.url)), 'fonts', 'NotoSansCJK-Regular.ttc'), '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc']) {
    try { await access(candidate); return candidate; } catch { /* Try the next installed font. */ }
  }
  return null;
})();
const formats = 'mov,matroska,webm,avi,mpeg,mpegts,ogg,flv';
let activeUploads = 0;
let uploadingBytes = 0;
let shuttingDown = false;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const activeExports = () => [...jobs.values()].filter(job => job.status === 'processing').length;
const safeName = name => (name || 'video').replace(/[\u0000-\u001f\u007f/\\]/g, '').slice(0, 180) || 'video';

function json(res, status, body) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function publicVideo(video) {
  return { id: video.id, name: video.name, duration: video.duration, width: video.width, height: video.height,
    hasAudio: video.hasAudio, url: `/api/videos/${video.id}/media`, thumbnailUrl: `/api/videos/${video.id}/thumbnail` };
}
function publicJob(job) {
  return { id: job.id, status: job.status, progress: job.progress, ...(job.error ? { error: job.error } : {}),
    ...(job.status === 'completed' ? { downloadUrl: `/api/exports/${job.id}/download`, duration: job.duration } : {}) };
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) fail(415, 'JSON 形式で送信してください。');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 64 * 1024) fail(413, '編集データが大きすぎます。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, '編集データを読み取れませんでした。'); }
}

function runProcess(program, args, { onProgress, duration = 1, timeout = 15 * 60 * 1000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd });
    children.add(child);
    let output = ''; let errors = ''; let lineBuffer = ''; let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.on('data', chunk => {
      if (program === 'ffprobe') {
        output += chunk.toString();
        if (output.length > 1024 * 1024) child.kill('SIGKILL');
      } else if (onProgress) {
        lineBuffer += chunk.toString();
        const lines = lineBuffer.split('\n'); lineBuffer = lines.pop();
        for (const line of lines) if (line.startsWith('out_time_us=')) {
          const seconds = Number(line.slice('out_time_us='.length)) / 1e6;
          if (Number.isFinite(seconds)) onProgress(Math.max(0, Math.min(1, seconds / duration)));
        }
      }
    });
    child.stderr.on('data', chunk => { errors = (errors + chunk.toString()).slice(-4096); });
    child.once('error', error => { clearTimeout(timer); children.delete(child); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); children.delete(child);
      if (code === 0) resolve(output);
      else reject(new Error(timedOut ? 'Media command timed out' : `Media command failed (${code}): ${errors}`));
    });
  });
}

const ffmpeg = (args, options) => runProcess('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-filter_threads', '1', '-filter_complex_threads', '1',
  ...args, '-progress', 'pipe:1', '-nostats',
], options);
const encoder = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-threads', '2', '-pix_fmt', 'yuv420p'];

async function upload(req, res, url) {
  if (activeUploads >= 2) fail(429, '読み込み処理中です。少し待ってから再試行してください。');
  if (videos.size + activeUploads >= 30) fail(429, '素材は 30 個まで読み込めます。');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxUpload) fail(413, '動画は 500 MB 以下にしてください。');
  const reserved = [...videos.values()].reduce((sum, video) => sum + video.size, 0);
  if (reserved + (declared || maxUpload) > maxStorage) fail(413, '素材の保存容量を超えました。アプリを再起動してから再試行してください。');
  activeUploads++;
  const id = randomUUID();
  const directory = path.join(dataRoot, id);
  const source = path.join(directory, 'source');
  let accepted = false;
  let size = 0;
  try {
    await mkdir(directory);
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      const stored = [...videos.values()].reduce((sum, video) => sum + video.size, 0);
      if (size + chunk.length > maxUpload || stored + uploadingBytes + chunk.length > maxStorage) {
        callback(new HttpError(413, '動画は 500 MB 以下、素材の合計は 2 GB 以下にしてください。'));
      } else {
        size += chunk.length; uploadingBytes += chunk.length; callback(null, chunk);
      }
    } });
    // Do not destroy the request on a size error: retain the connection long enough to report it.
    req.pipe(limiter);
    const abort = () => limiter.destroy(new HttpError(400, '動画の読み込みが中断されました。'));
    req.once('aborted', abort);
    req.once('error', abort);
    try { await pipeline(limiter, createWriteStream(source, { flags: 'wx' })); }
    finally { req.removeListener('aborted', abort); req.removeListener('error', abort); req.unpipe(limiter); }
    if (!size) fail(400, '空の動画ファイルは読み込めません。');
    let metadata;
    try {
      metadata = JSON.parse(await runProcess('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file,pipe',
        '-format_whitelist', formats, '-show_format', '-show_streams', '-of', 'json', source], { timeout: 30_000 }));
    } catch { fail(422, 'この動画を読み込めません。MP4、MOV、WebM などの動画を選んでください。'); }
    const stream = metadata.streams?.find(item => item.codec_type === 'video' && !item.disposition?.attached_pic);
    const duration = Number(metadata.format?.duration || stream?.duration);
    if (!stream || !Number.isFinite(duration) || duration <= 0 || duration > maxDuration ||
      !Number.isInteger(stream.width) || !Number.isInteger(stream.height) || stream.width < 2 || stream.height < 2 ||
      stream.width > 8192 || stream.height > 8192) fail(422, '対応していない動画です。4 時間以内・8192 px 以下の動画を選んでください。');
    let width = stream.width; let height = stream.height;
    const rotation = Number(stream.side_data_list?.find(item => item.rotation !== undefined)?.rotation || stream.tags?.rotate || 0);
    if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
    const thumbnail = path.join(directory, 'thumbnail.jpg');
    try {
      await ffmpeg(['-protocol_whitelist', 'file,pipe', '-format_whitelist', formats, '-ss', String(Math.min(duration / 4, 1)),
        '-i', source, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=480:-2', '-threads', '2', thumbnail], { timeout: 30_000 });
    } catch { fail(422, '動画のプレビューを作成できませんでした。別の動画を選んでください。'); }
    const formatNames = metadata.format.format_name.split(',');
    const sourceMime = formatNames.includes('matroska')
      ? (['vp8', 'vp9', 'av1'].includes(stream.codec_name) ? 'video/webm' : 'video/x-matroska')
      : formatNames.includes('ogg') ? 'video/ogg'
      : formatNames.includes('avi') ? 'video/x-msvideo'
      : formatNames.includes('mpegts') ? 'video/mp2t'
      : formatNames.includes('mpeg') ? 'video/mpeg'
      : formatNames.includes('flv') ? 'video/x-flv' : 'video/mp4';
    const video = { id, name: safeName(url.searchParams.get('name')), duration, width, height, sourceMime,
      hasAudio: metadata.streams.some(item => item.codec_type === 'audio'), source, directory, thumbnail, size, touched: Date.now() };
    videos.set(id, video); accepted = true;
    json(res, 201, publicVideo(video));
  } finally {
    activeUploads--; uploadingBytes -= size;
    if (!accepted) await rm(directory, { recursive: true, force: true });
  }
}

function validateEdit(body) {
  if (!body || typeof body !== 'object' || !Array.isArray(body.clips) || body.clips.length < 1 || body.clips.length > 20)
    fail(400, '動画クリップを 1〜20 個選んでください。');
  const clips = body.clips.map(clip => {
    const video = videos.get(clip?.videoId);
    if (!video) fail(404, '動画素材が見つかりません。再度読み込んでください。');
    const { start, end } = clip;
    const volume = clip.volume ?? 1;
    if (!finite(start) || !finite(end) || start < 0 || end <= start || end > video.duration + 0.001 || end - start < 0.05)
      fail(400, 'カット範囲を動画の長さに合わせて指定してください（最短 0.05 秒）。');
    if (!finite(volume) || volume < 0 || volume > 1) fail(400, '音量は 0〜1 の範囲で指定してください。');
    return { video, start, end: Math.min(end, video.duration), volume };
  });
  const duration = clips.reduce((sum, clip) => sum + clip.end - clip.start, 0);
  if (duration > maxDuration) fail(400, '書き出せる動画は合計 4 時間までです。');
  const captions = body.texts ?? [];
  if (!Array.isArray(captions) || captions.length > 20) fail(400, 'テキストは 20 個まで追加できます。');
  if (captions.length && !font) fail(503, '字幕用フォントが見つかりません。アプリの ZIP をすべて展開し直してください。');
  const texts = captions.map(caption => {
    if (!caption || typeof caption.text !== 'string' || !caption.text.trim() || [...caption.text].length > 200 ||
      caption.text.includes('\0') || !finite(caption.start) || !finite(caption.end) || caption.start < 0 ||
      caption.end <= caption.start || caption.end > duration + 0.01)
      fail(400, 'テキストは 200 文字以内、表示時間は動画の範囲内で指定してください。');
    return { text: caption.text, start: caption.start, end: Math.min(caption.end, duration) };
  });
  return { clips, texts, duration };
}

async function renderJob(job, edit) {
  const directory = path.join(dataRoot, `export-${job.id}`);
  job.directory = directory;
  try {
    await mkdir(directory);
    const first = edit.clips[0].video;
    const factor = Math.min(1, 1920 / Math.max(first.width, first.height));
    const width = Math.max(2, Math.floor(first.width * factor / 2) * 2);
    const height = Math.max(2, Math.floor(first.height * factor / 2) * 2);
    let done = 0;
    const normalizeWeight = edit.texts.length ? 65 : 95;
    const outputs = [];
    for (let index = 0; index < edit.clips.length; index++) {
      const clip = edit.clips[index];
      const duration = clip.end - clip.start;
      const output = path.join(directory, `clip-${index}.mp4`);
      const input = ['-ss', String(clip.start), '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats, '-i', clip.video.source];
      if (!clip.video.hasAudio) input.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
      const filter = `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p`;
      await ffmpeg([...input, '-t', String(duration), '-map', '0:v:0', '-map', clip.video.hasAudio ? '0:a:0' : '1:a:0',
        '-vf', filter, '-af', `volume=${clip.volume},aresample=48000:async=1:first_pts=0,apad=whole_dur=${duration},atrim=duration=${duration}`, ...encoder,
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-map_metadata', '-1', '-movflags', '+faststart', output], {
          duration, onProgress: part => { job.progress = Math.min(99, Math.round((done + duration * part) / edit.duration * normalizeWeight)); },
        });
      done += duration; outputs.push(output);
      job.progress = Math.round(done / edit.duration * normalizeWeight);
    }
    const list = path.join(directory, 'concat.txt');
    await writeFile(list, outputs.map((output, index) => `file 'clip-${index}.mp4'`).join('\n'));
    const combined = path.join(directory, edit.texts.length ? 'combined.mp4' : 'output.mp4');
    await ffmpeg(['-f', 'concat', '-safe', '1', '-i', list, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-movflags', '+faststart', combined], {
      duration: edit.duration, onProgress: part => { job.progress = normalizeWeight + Math.round(part * (edit.texts.length ? 3 : 4)); },
    });
    if (edit.texts.length) {
      // Relative filter paths avoid Windows drive-colon/backslash escaping and
      // work under user directories containing spaces, apostrophes or Japanese.
      await copyFile(font, path.join(directory, 'font.ttc'));
      const filters = [];
      for (let index = 0; index < edit.texts.length; index++) {
        const text = edit.texts[index];
        const textFile = path.join(directory, `text-${index}.txt`);
        await writeFile(textFile, text.text, 'utf8');
        const fontSize = Math.max(16, Math.round(height * 0.045));
        // Match the preview's bottom-up subtitle stack. Only captions currently visible
        // consume space, so later captions return to the bottom when earlier ones end.
        const offsets = edit.texts.slice(0, index).map(previous => {
          const lines = previous.text.split(/\r\n|\n|\r/).length;
          const blockHeight = Math.ceil(fontSize * 1.4 * lines) + 24;
          return `${blockHeight}*gte(t,${previous.start})*lt(t,${previous.end})`;
        });
        const y = 'h-text_h-h*0.08' + offsets.map(offset => `-(${offset})`).join('');
        filters.push(`drawtext=fontfile=font.ttc:textfile=text-${index}.txt:expansion=none:fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=10:x=(w-text_w)/2:y='${y}':enable='gte(t,${text.start})*lt(t,${text.end})'`);
      }
      const output = path.join(directory, 'output.mp4');
      await ffmpeg(['-i', combined, '-map', '0:v:0', '-map', '0:a:0', '-vf', filters.join(','), ...encoder,
        '-c:a', 'copy', '-movflags', '+faststart', output], {
          cwd: directory, duration: edit.duration, onProgress: part => { job.progress = Math.min(99, 68 + Math.round(part * 31)); },
        });
    }
    job.output = path.join(directory, 'output.mp4');
    job.progress = 100; job.status = 'completed';
    // Retain only the final artifact; intermediate media can be large.
    for (const output of outputs) await rm(output, { force: true }).catch(() => {});
    if (edit.texts.length) {
      await rm(combined, { force: true }).catch(() => {});
      await rm(path.join(directory, 'font.ttc'), { force: true }).catch(() => {});
    }
  } catch (error) {
    console.error(`Export ${job.id} failed:`, error.message);
    job.status = 'failed';
    job.error = '書き出しに失敗しました。動画の形式や空き容量を確認して、もう一度お試しください。';
    await rm(directory, { recursive: true, force: true }).catch(() => {});
  } finally { job.touched = Date.now(); }
}

async function exportVideo(req, res, videoId) {
  if (activeExports() >= 2) fail(429, '他の動画を書き出し中です。完了してから再試行してください。');
  if (jobs.size >= 30) fail(429, '書き出し履歴が上限に達しました。アプリを再起動してください。');
  let body = await readJson(req);
  if (videoId) body = { clips: [{ videoId, start: body?.start, end: body?.end, volume: body?.volume }], texts: body?.texts };
  const edit = validateEdit(body);
  // Recheck after reading the request so concurrent callers cannot bypass the bound.
  if (activeExports() >= 2) fail(429, '他の動画を書き出し中です。完了してから再試行してください。');
  const job = { id: randomUUID(), status: 'processing', progress: 0, duration: edit.duration,
    videoIds: edit.clips.map(clip => clip.video.id), touched: Date.now() };
  for (const clip of edit.clips) clip.video.touched = Date.now();
  jobs.set(job.id, job);
  json(res, 202, publicJob(job));
  void renderJob(job, edit);
}

async function sendFile(req, res, filename, contentType, download = false) {
  const info = await stat(filename);
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': download ? 'no-store' : ['text/html', 'text/javascript', 'text/css'].some(type => contentType.startsWith(type)) ? 'no-store' : 'private, max-age=3600' };
  if (download) headers['Content-Disposition'] = 'attachment; filename="frame-edit.mp4"';
  let start = 0; let end = info.size - 1; let status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
    }
    if (!match[1]) { start = Math.max(0, info.size - Number(match[2])); }
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return;
    }
    headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`; status = 206;
  }
  headers['Content-Length'] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  await pipeline(createReadStream(filename, { start, end }), res).catch(error => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error;
  });
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.mp4': 'video/mp4' };

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && req.headers.origin) {
      let origin;
      try { origin = new URL(req.headers.origin); } catch { fail(403, '許可されていないリクエストです。'); }
      if (origin.host !== req.headers.host && origin.host !== req.headers['x-forwarded-host']) fail(403, '許可されていないリクエストです。');
    }
    if (req.method === 'GET' && url.pathname === '/api/health') { json(res, 200, { ok: true }); return; }
    if (req.method === 'POST' && url.pathname === '/api/videos') { await upload(req, res, url); return; }
    if (req.method === 'POST' && url.pathname === '/api/exports') { await exportVideo(req, res); return; }
    const videoMatch = /^\/api\/videos\/([a-f0-9-]{36})\/(media|thumbnail|exports)$/.exec(url.pathname);
    if (videoMatch) {
      const video = videos.get(videoMatch[1]);
      if (!video) fail(404, '動画素材が見つかりません。再度読み込んでください。');
      video.touched = Date.now();
      if (req.method === 'POST' && videoMatch[2] === 'exports') { await exportVideo(req, res, video.id); return; }
      if (['GET', 'HEAD'].includes(req.method) && videoMatch[2] !== 'exports') {
        await sendFile(req, res, videoMatch[2] === 'thumbnail' ? video.thumbnail : video.source,
          videoMatch[2] === 'thumbnail' ? 'image/jpeg' : video.sourceMime); return;
      }
    }
    const exportMatch = /^\/api\/exports\/([a-f0-9-]{36})(\/download)?$/.exec(url.pathname);
    if (exportMatch && ['GET', 'HEAD'].includes(req.method)) {
      const job = jobs.get(exportMatch[1]);
      if (!job) fail(404, '書き出し結果が見つかりません。');
      job.touched = Date.now();
      if (!exportMatch[2]) { json(res, 200, publicJob(job)); return; }
      if (job.status !== 'completed') fail(409, '書き出しがまだ完了していません。');
      await sendFile(req, res, job.output, 'video/mp4', true); return;
    }
    if (url.pathname.startsWith('/api/')) fail(404, 'API が見つかりません。');
    if (!['GET', 'HEAD'].includes(req.method)) fail(405, '対応していない操作です。');
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { fail(400, '無効な URL です。'); }
    const filename = path.resolve(publicRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(publicRoot + path.sep)) fail(404, 'ファイルが見つかりません。');
    let resolved;
    try { resolved = await realpath(filename); } catch { fail(404, 'ファイルが見つかりません。'); }
    if (!resolved.startsWith(publicRoot + path.sep)) fail(404, 'ファイルが見つかりません。');
    await sendFile(req, res, resolved, mime[path.extname(resolved)] || 'application/octet-stream');
  } catch (error) {
    if (res.destroyed) return;
    if (res.headersSent) { res.destroy(); return; }
    if (!(error instanceof HttpError)) console.error('Request failed:', error.message);
    if (error.status === 413) { res.setHeader('Connection', 'close'); req.resume(); }
    json(res, error.status || 500, { error: error instanceof HttpError ? error.message : '処理に失敗しました。もう一度お試しください。' });
  }
});
server.requestTimeout = 10 * 60 * 1000;

const cleanupTimer = setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs) if (job.status !== 'processing' && now - job.touched > ttl) {
    jobs.delete(id); await rm(job.directory, { recursive: true, force: true }).catch(() => {});
  }
  const inUse = new Set([...jobs.values()].filter(job => job.status === 'processing').flatMap(job => job.videoIds));
  for (const [id, video] of videos) if (!inUse.has(id) && now - video.touched > ttl) {
    videos.delete(id); await rm(video.directory, { recursive: true, force: true }).catch(() => {});
  }
}, 5 * 60 * 1000);
cleanupTimer.unref();

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true; clearInterval(cleanupTimer); server.close();
  for (const child of children) child.kill('SIGKILL');
  await rm(dataRoot, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
server.listen(Number(process.env.PORT || 3000), process.env.HOST || '0.0.0.0', () => {
  console.log(`FRAME video editor running on port ${server.address().port}`);
});
