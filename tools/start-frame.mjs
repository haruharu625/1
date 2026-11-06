#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this launcher dependency-free so the Windows download needs no npm install.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let child;
let childEnded = false;
let spawnError;
let requestedSignal;
let forceTimer;
let serverAnnounced = false;

function stopChild() {
  if (!child || childEnded) return;
  child.kill('SIGTERM');
  if (!forceTimer) {
    forceTimer = setTimeout(() => {
      if (!childEnded) child.kill('SIGKILL');
    }, 5_000);
    forceTimer.unref();
  }
}

function checkDependency(command) {
  const result = spawnSync(command, ['-version'], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} is not available. Install FFmpeg (including ffprobe), add its bin folder to PATH, then reopen this launcher. See the Windows setup guide in this folder.`);
  }
}

async function availablePort() {
  for (let port = 3000; port < 3100; port++) {
    const outcome = await new Promise(resolve => {
      const probe = net.createServer();
      probe.once('error', error => resolve(error));
      probe.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
        probe.close(error => resolve(error || null));
      });
    });
    if (!outcome) return port;
    if (!['EADDRINUSE', 'EACCES'].includes(outcome.code)) {
      throw new Error(`Cannot open a local server port (${outcome.code || outcome.message}). Check local firewall or app permissions.`);
    }
  }
  throw new Error('No available local port between 3000 and 3099. Close another FRAME instance or other local servers, then try again.');
}

function health(url) {
  return new Promise(resolve => {
    const request = http.get(new URL('api/health', url), { timeout: 1_000 }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        text += chunk;
        if (text.length > 1024) request.destroy();
      });
      response.once('end', () => {
        try { resolve(response.statusCode === 200 && JSON.parse(text).ok === true); }
        catch { resolve(false); }
      });
      response.once('error', () => resolve(false));
    });
    request.once('timeout', () => { request.destroy(); resolve(false); });
    request.once('error', () => resolve(false));
  });
}

function openBrowser(url) {
  // The only argument is our constant loopback URL plus a numeric, locally chosen
  // port. No filenames, project names, or other user input enters a shell command.
  let program;
  let browserArgs;
  if (process.platform === 'win32') {
    program = 'powershell.exe';
    browserArgs = ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process', url];
  } else if (process.platform === 'darwin') {
    program = 'open'; browserArgs = [url];
  } else {
    console.log('Open APP_URL above in your browser.');
    return Promise.resolve();
  }
  return new Promise(resolve => {
    const browser = spawn(program, browserArgs, { stdio: 'ignore', windowsHide: true });
    let reported = false;
    const warn = () => {
      if (!reported) console.warn(`Could not open the browser automatically. Open ${url} manually.`);
      reported = true;
    };
    browser.once('error', () => { warn(); resolve(); });
    browser.once('close', code => { if (code !== 0) warn(); resolve(); });
    // A slow browser launcher must not block the server or its shutdown handling.
    const timer = setTimeout(() => {
      warn(); browser.unref(); resolve();
    }, 10_000);
    timer.unref();
    browser.once('close', () => clearTimeout(timer));
  });
}

async function main() {
  if (args.includes('--help')) {
    console.log('Usage: node tools/start-frame.mjs [--no-open]\nStarts FRAME on an available localhost port. Keep this terminal open.');
    return;
  }
  const unknown = args.find(arg => arg !== '--no-open');
  if (unknown) throw new Error(`Unknown option: ${unknown}. Use --no-open or --help.`);
  if (Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('Node.js 20 or newer is required. Install the current Node.js LTS version, then try again.');
  }
  try { await access(path.join(root, 'server.mjs')); }
  catch { throw new Error('server.mjs is missing. Extract the entire FRAME ZIP before starting; do not move the launcher or open index.html directly.'); }
  checkDependency('ffmpeg');
  checkDependency('ffprobe');
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  console.log('Starting FRAME. Keep this terminal open while editing. Press Ctrl+C to stop.');
  child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
    cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    stdout = (stdout + chunk.toString()).slice(-4096);
    // A health response from another server that wins the probe/spawn race does
    // not count as readiness. Our child must also announce a successful bind.
    if (stdout.includes(`FRAME video editor running on port ${port}`)) serverAnnounced = true;
  });
  child.stderr.pipe(process.stderr);
  const closed = new Promise(resolve => {
    child.once('error', error => { spawnError = error; childEnded = true; resolve({ code: 1 }); });
    child.once('exit', () => { childEnded = true; });
    child.once('close', (code, signal) => { clearTimeout(forceTimer); resolve({ code, signal }); });
  });
  const signalHandlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      if (requestedSignal && !childEnded) child.kill('SIGKILL');
      requestedSignal = signal; stopChild();
    };
    signalHandlers.set(signal, handler); process.on(signal, handler);
  }
  try {
    let ready = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !requestedSignal) {
      if (childEnded) {
        const result = await closed;
        const error = new Error(spawnError
          ? `Could not start the app server: ${spawnError.message}`
          : `The app server stopped during startup. Port ${port} may have become busy; try starting again. See the server message above.`);
        error.exitCode = result.code || 1;
        throw error;
      }
      if (serverAnnounced && await health(url)) { ready = true; break; }
      await delay(100);
    }
    if (requestedSignal) { await closed; return; }
    if (!ready) throw new Error('The app server did not become ready within 20 seconds. See the server message above, then try again.');
    console.log(`APP_URL=${url}`);
    console.log('Use this address in a browser. Do not open public/index.html as a file.');
    if (!args.includes('--no-open')) await openBrowser(url);
    const result = await closed;
    if (!requestedSignal) {
      process.exitCode = result.code ?? 1;
      if (result.code !== 0) console.error(`FRAME server stopped (${result.signal || result.code || 'unknown error'}).`);
    }
  } catch (error) {
    stopChild(); await closed; throw error;
  } finally {
    clearTimeout(forceTimer);
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    if (requestedSignal) process.exitCode = requestedSignal === 'SIGINT' ? 130 : 143;
  }
}

main().catch(error => {
  console.error(`\nFRAME could not start: ${error.message}`);
  process.exitCode = error.exitCode || 1;
});
