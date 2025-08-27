require('dotenv').config();
const axios = require('axios');
const fs = require('fs-extra');
const path = require('path');
const { JSDOM } = require('jsdom');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');

// --- Config ---
const ADMIN_PORT = process.env.ADMIN_PORT || 3000;
const MIRRORS = (process.env.MIRRORS || 'https://mirror.rackspace.com/archlinux').split(',');
const REPOS = ['core', 'extra', 'community'];
const ARCH = process.env.ARCH || 'x86_64';
const TIMEOUT_MS = parseInt(process.env.FILE_TIMEOUT_MS || '1000', 10);
const DOWNLOAD_SPEED_LIMIT_KBPS = parseInt(process.env.DOWNLOAD_SPEED_LIMIT_KBPS || '-1', 10);

// --- Web server setup (unchanged) ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let syncState = {
  currentTask: 'Idle',
  progress: 0,
  total: 0,
  eta: null,
  diskUsage: null,
  progressBar: 0,
  timeSpent: 0,
  estimatedSizeIncrease: 0,
  estimatedSizeIncreaseReady: false,
  running: false,
  currentFileProgress: 0,
  currentFileSpeed: 0
};

let syncAbortController = { stop: false };

function getDiskUsage(dir) {
  // Simple disk usage: sum file sizes in dir (recursive)
  let total = 0;
  function walk(p) {
    if (fs.existsSync(p)) {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        fs.readdirSync(p).forEach(f => walk(path.join(p, f)));
      } else {
        total += stat.size;
      }
    }
  }
  walk(dir);
  return total;
}

function broadcastState() {
  syncState.diskUsage = getDiskUsage(path.join(__dirname, 'mirror'));
  const msg = JSON.stringify(syncState);
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

// --- WebSocket control for start/stop ---
wss.on('connection', ws => {
  ws.send(JSON.stringify(syncState));
  ws.on('message', msg => {
    try {
      const data = JSON.parse(msg);
      if (data.action === 'stop') {
        syncAbortController.stop = true;
        syncState.running = false;
        syncState.currentTask = 'Stopped by user';
        broadcastState();
      } else if (data.action === 'start') {
        if (!syncState.running) {
          syncAbortController.stop = false;
          syncState.currentTask = 'Starting download...';
          broadcastState();
          syncMirror();
        }
      }
    } catch {}
  });
});

app.use('/admin', express.static(path.join(__dirname, 'admin.html')));

server.listen(ADMIN_PORT, () => {
  console.log(`Admin interface: http://localhost:${ADMIN_PORT}/admin`);
});

// --- Mirror sync logic ---

async function fetchFileList(repo, mirror) {
  const url = `${mirror}/${repo}/os/${ARCH}/`;
  const res = await axios.get(url, { timeout: 10000 });
  const dom = new JSDOM(res.data);
  const links = [...dom.window.document.querySelectorAll('a')];
  // Return objects with filename and href for correct structure
  return links
    .map(a => ({
      name: a.textContent,
      href: a.getAttribute('href')
    }))
    .filter(link => !link.href.startsWith('?') && !link.href.startsWith('/'))
    .filter(link => !link.href.endsWith('/'));
}

function getRelativeMirrorPath(repo, fileObj) {
  // fileObj.href is relative to /repo/os/ARCH/
  // We want: repo/os/ARCH/<fileObj.href>
  // Remove any leading './' or '/' from href
  let cleanHref = fileObj.href.replace(/^\.?\//, '');
  return path.join(repo, 'os', ARCH, cleanHref);
}

async function downloadFile(repo, fileObj, mirrors) {
  let lastError;
  for (const mirror of mirrors) {
    // Build the correct relative path from the href (to preserve structure)
    const remoteUrl = new URL(`${mirror}/${repo}/os/${ARCH}/`);
    const fileUrl = new URL(fileObj.href, remoteUrl);
    const relPath = getRelativeMirrorPath(repo, fileObj);
    const localPath = path.join(__dirname, 'mirror', relPath);

    // Check if file exists and is up-to-date
    if (await fs.pathExists(localPath)) {
      return;
    }

    try {
      console.log(`Downloading ${relPath} from ${mirror}...`);
      const res = await axios.get(fileUrl.href, { responseType: 'stream', timeout: 30000 });
      await fs.ensureDir(path.dirname(localPath));
      const writer = fs.createWriteStream(localPath);

      // Track progress
      let received = 0;
      let total = parseInt(res.headers['content-length'] || '0', 10);
      let lastReceived = 0;
      let lastTime = Date.now();
      syncState.currentFileProgress = 0;
      syncState.currentFileSpeed = 0;

      res.data.on('data', chunk => {
        received += chunk.length;
        // Progress %
        syncState.currentFileProgress = total > 0 ? Math.round((received / total) * 100) : 0;
        // Speed (bytes/sec)
        const now = Date.now();
        if (now - lastTime >= 1000) {
          syncState.currentFileSpeed = Math.round((received - lastReceived) / ((now - lastTime) / 1000));
          lastReceived = received;
          lastTime = now;
        }
        broadcastState();
      });

      // Throttle if needed
      if (DOWNLOAD_SPEED_LIMIT_KBPS > 0) {
        const stream = res.data;
        let bytesThisSecond = 0;
        let throttleLastTime = Date.now();
        stream.on('data', chunk => {
          bytesThisSecond += chunk.length;
          const now = Date.now();
          if (bytesThisSecond > DOWNLOAD_SPEED_LIMIT_KBPS * 1024) {
            const elapsed = now - throttleLastTime;
            if (elapsed < 1000) {
              stream.pause();
              setTimeout(() => {
                bytesThisSecond = 0;
                throttleLastTime = Date.now();
                stream.resume();
              }, 1000 - elapsed);
            } else {
              bytesThisSecond = 0;
              throttleLastTime = now;
            }
          }
        });
        stream.pipe(writer);
      } else {
        res.data.pipe(writer);
      }

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
      // Reset after file done
      syncState.currentFileProgress = 100;
      syncState.currentFileSpeed = 0;
      broadcastState();
      return; // success
    } catch (err) {
      lastError = err;
      console.warn(`Failed to download from ${mirror}: ${err.message}`);
      // Try next mirror
    }
  }
  throw lastError;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function estimateSizeIncrease(allFiles) {
  let size = 0;
  let checked = 0;
  for (const { repo, fileObj } of allFiles) {
    if (checked % 100 === 0) {
      syncState.estimatedSizeIncrease = size;
      syncState.estimatedSizeIncreaseReady = false;
      broadcastState();
      await sleep(1); // Yield to event loop
    }
    checked++;
    const relPath = getRelativeMirrorPath(repo, fileObj);
    const localPath = path.join(__dirname, 'mirror', relPath);
    try {
      if (!(await fs.pathExists(localPath))) {
        const remoteUrl = new URL(`${MIRRORS[0]}/${repo}/os/${ARCH}/`);
        const fileUrl = new URL(fileObj.href, remoteUrl);
        const res = await axios.head(fileUrl.href, { timeout: 5000 });
        if (res.headers['content-length']) {
          size += parseInt(res.headers['content-length'], 10);
        }
      }
    } catch {}
  }
  syncState.estimatedSizeIncrease = size;
  syncState.estimatedSizeIncreaseReady = true;
  broadcastState();
}

async function syncMirror() {
  if (syncState.running) return;
  syncState.running = true;
  syncAbortController.stop = false;
  let allFiles = [];
  // Fetch file lists for all repos from the first mirror
  for (const repo of REPOS) {
    try {
      const files = await fetchFileList(repo, MIRRORS[0]);
      allFiles = allFiles.concat(files.map(f => ({ repo, fileObj: f })));
    } catch (err) {
      console.error(`Failed to fetch file list for ${repo}:`, err.message);
    }
  }
  syncState.total = allFiles.length;
  syncState.progress = 0;
  syncState.currentTask = 'Syncing';
  syncState.timeSpent = 0;
  syncState.progressBar = 0;
  syncState.estimatedSizeIncrease = 0;
  syncState.estimatedSizeIncreaseReady = false;
  broadcastState();

  // Start size estimation in the background
  estimateSizeIncrease(allFiles);

  let startTime = Date.now();

  for (let i = 0; i < allFiles.length; i++) {
    if (syncAbortController.stop) break;
    const { repo, fileObj } = allFiles[i];
    syncState.progress = i + 1;
    syncState.currentTask = `Downloading ${repo}/${fileObj.name}`;
    syncState.currentFileProgress = 0;
    syncState.currentFileSpeed = 0;
    // Estimate ETA
    const elapsed = (Date.now() - startTime) / 1000;
    syncState.timeSpent = Math.round(elapsed);
    const avgPerFile = elapsed / (i + 1);
    syncState.eta = Math.round(avgPerFile * (allFiles.length - (i + 1)));
    syncState.progressBar = Math.round(((i + 1) / allFiles.length) * 100);
    broadcastState();
    try {
      await downloadFile(repo, fileObj, MIRRORS);
    } catch (err) {
      console.error(`Failed to download ${repo}/${fileObj.name} from all mirrors:`, err.message);
    }
    await sleep(TIMEOUT_MS);
  }
  syncState.currentTask = syncAbortController.stop ? 'Stopped by user' : 'Idle';
  syncState.eta = 0;
  syncState.running = false;
  syncState.progressBar = 100;
  syncState.currentFileProgress = 0;
  syncState.currentFileSpeed = 0;
  broadcastState();
  console.log('Sync complete.');
}

if (process.env.AUTO_START !== 'false') {
  syncMirror().catch(err => {
    syncState.currentTask = 'Error';
    syncState.running = false;
    broadcastState();
    console.error('Sync failed:', err);
  });
}
