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

// --- Web server setup (unchanged) ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let syncState = {
  currentTask: 'Idle',
  progress: 0,
  total: 0,
  eta: null,
  diskUsage: null
};

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

wss.on('connection', ws => {
  ws.send(JSON.stringify(syncState));
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
  return links
    .map(a => a.href)
    .filter(href => !href.startsWith('?') && !href.startsWith('/'))
    .filter(href => !href.endsWith('/'));
}

async function downloadFile(repo, filename, mirrors) {
  let lastError;
  for (const mirror of mirrors) {
    const url = `${mirror}/${repo}/os/${ARCH}/${filename}`;
    const localPath = path.join(__dirname, 'mirror', repo, 'os', ARCH, filename);

    // Check if file exists and is up-to-date
    if (await fs.pathExists(localPath)) {
      return;
    }

    try {
      console.log(`Downloading ${filename} from ${mirror}...`);
      const res = await axios.get(url, { responseType: 'stream', timeout: 30000 });
      await fs.ensureDir(path.dirname(localPath));
      const writer = fs.createWriteStream(localPath);
      res.data.pipe(writer);
      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });
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

async function syncMirror() {
  let allFiles = [];
  let repoFiles = {};
  // Fetch file lists for all repos from the first mirror
  for (const repo of REPOS) {
    try {
      const files = await fetchFileList(repo, MIRRORS[0]);
      repoFiles[repo] = files;
      allFiles = allFiles.concat(files.map(f => ({ repo, filename: f })));
    } catch (err) {
      console.error(`Failed to fetch file list for ${repo}:`, err.message);
    }
  }
  syncState.total = allFiles.length;
  syncState.progress = 0;
  syncState.currentTask = 'Syncing';
  let startTime = Date.now();

  for (let i = 0; i < allFiles.length; i++) {
    const { repo, filename } = allFiles[i];
    syncState.progress = i + 1;
    syncState.currentTask = `Downloading ${repo}/${filename}`;
    // Estimate ETA
    const elapsed = (Date.now() - startTime) / 1000;
    const avgPerFile = elapsed / (i + 1);
    syncState.eta = Math.round(avgPerFile * (allFiles.length - (i + 1)));
    broadcastState();
    try {
      await downloadFile(repo, filename, MIRRORS);
    } catch (err) {
      console.error(`Failed to download ${repo}/${filename} from all mirrors:`, err.message);
    }
    await sleep(TIMEOUT_MS);
  }
  syncState.currentTask = 'Idle';
  syncState.eta = 0;
  broadcastState();
  console.log('Sync complete.');
}

syncMirror().catch(err => {
  syncState.currentTask = 'Error';
  broadcastState();
  console.error('Sync failed:', err);
});
