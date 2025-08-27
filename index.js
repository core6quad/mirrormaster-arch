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
const MULTITHREADED = process.env.MULTITHREADED === 'true';

// Only include these top-level folders (comma-separated, configurable)
const MIRROR_INCLUDE_FOLDERS = (process.env.MIRROR_INCLUDE_FOLDERS || 'core,extra,community,multilib').split(',').map(f => f.trim()).filter(Boolean);

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
  currentFileSpeed: 0,
  log: [],
  currentTasks: [],
  currentWorkers: 0
};

const LOG_LIMIT = 200;

function addLog(msg) {
  const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
  syncState.log.push(line);
  if (syncState.log.length > LOG_LIMIT) syncState.log = syncState.log.slice(-LOG_LIMIT);
  broadcastState();
  // Also print to console
  console.log(line);
}

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
  // This ensures files go to mirror/core/os/x86_64, mirror/extra/os/x86_64, etc.
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
      addLog(`Downloading ${relPath} from ${mirror}...`);
      const res = await axios.get(fileUrl.href, { responseType: 'stream', timeout: 30000 });
      await fs.ensureDir(path.dirname(localPath));
      const writer = fs.createWriteStream(localPath);

      // Track progress
      let received = 0;
      let total = parseInt(res.headers['content-length'] || '0', 10);
      let lastReceived = 0;
      let lastTime = Date.now();
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
      syncState.currentFileProgress = 100;
      syncState.currentFileSpeed = 0;
      broadcastState();
      addLog(`Downloaded ${relPath} from ${mirror}`);
      return; // success
    } catch (err) {
      lastError = err;
      addLog(`Failed to download ${relPath} from ${mirror}: ${err.message}`);
      // Try next mirror
    }
  }
  addLog(`Failed to download ${relPath} from all mirrors.`);
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

async function downloadFileWithThrottle(repo, fileObj, mirror, perThreadSpeedLimitKbps, workerId) {
  const remoteUrl = new URL(`${mirror}/${repo}/os/${ARCH}/`);
  const fileUrl = new URL(fileObj.href, remoteUrl);
  const relPath = getRelativeMirrorPath(repo, fileObj);
  // Track current task for this worker
  syncState.currentTasks[workerId] = `${repo}/${fileObj.name}`;
  syncState.currentWorkers = syncState.currentTasks.filter(Boolean).length;
  broadcastState();

  const localPath = path.join(__dirname, 'mirror', relPath);
  if (await fs.pathExists(localPath)) return;

  try {
    // Log file download event
    addLog(`Worker #${workerId + 1}: Downloading ${relPath} from ${mirror}...`);
    const res = await axios.get(fileUrl.href, { responseType: 'stream', timeout: 30000 });
    await fs.ensureDir(path.dirname(localPath));
    const writer = fs.createWriteStream(localPath);

    // Track progress (per file, not global)
    let received = 0;
    let total = parseInt(res.headers['content-length'] || '0', 10);
    let lastReceived = 0;
    let lastTime = Date.now();

    res.data.on('data', chunk => {
      received += chunk.length;
      // No global progress update here (handled by main thread)
      const now = Date.now();
      if (now - lastTime >= 1000) {
        lastReceived = received;
        lastTime = now;
      }
    });

    // Throttle if needed
    if (perThreadSpeedLimitKbps > 0) {
      const stream = res.data;
      let bytesThisSecond = 0;
      let throttleLastTime = Date.now();
      stream.on('data', chunk => {
        bytesThisSecond += chunk.length;
        const now = Date.now();
        if (bytesThisSecond > perThreadSpeedLimitKbps * 1024) {
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
    addLog(`Worker #${workerId + 1}: Downloaded ${relPath} from ${mirror}`);
    // Remove from currentTasks
    syncState.currentTasks[workerId] = null;
    syncState.currentWorkers = syncState.currentTasks.filter(Boolean).length;
    broadcastState();
    return;
  } catch (err) {
    addLog(`Worker #${workerId + 1}: Failed to download ${relPath} from ${mirror}: ${err.message}`);
    syncState.currentTasks[workerId] = null;
    syncState.currentWorkers = syncState.currentTasks.filter(Boolean).length;
    broadcastState();
    throw err;
  }
}

// Set the root path to clone (relative to the mirror root)
const MIRROR_ROOT_PATH = process.env.MIRROR_ROOT_PATH || ''; // e.g. '' for full, or 'core/os/x86_64/'

// --- Improved scanning speed and reliability ---
const DIR_LIST_TIMEOUT = 7000; // ms, lower timeout for directory listing
const DIR_SCAN_CONCURRENCY = 10; // max concurrent directory requests

// Simple concurrency pool for async functions
function createConcurrencyPool(limit) {
  let active = 0;
  const queue = [];
  function run(fn) {
    return new Promise((resolve, reject) => {
      const task = async () => {
        active++;
        try {
          const result = await fn();
          resolve(result);
        } catch (err) {
          reject(err);
        } finally {
          active--;
          if (queue.length) queue.shift()();
        }
      };
      if (active < limit) {
        task();
      } else {
        queue.push(task);
      }
    });
  }
  return run;
}

const dirPool = createConcurrencyPool(DIR_SCAN_CONCURRENCY);

// Recursively fetch all files and directories from a given path on the mirror, with concurrency
async function fetchAllFilesRecursive(mirror, basePath = MIRROR_ROOT_PATH) {
  let url = mirror;
  if (!url.endsWith('/')) url += '/';
  url += basePath;
  if (url.endsWith('//')) url = url.replace(/\/+$/, '/'); // avoid double slash

  // Only scan allowed folders at the root level
  if (!basePath || basePath === '' || basePath === '/') {
    let files = [];
    try {
      const res = await dirPool(() =>
        axios.get(url, { timeout: DIR_LIST_TIMEOUT }).catch(e => { throw e; })
      );
      const dom = new JSDOM(res.data);
      const links = [...dom.window.document.querySelectorAll('a')];
      const subdirPromises = [];
      for (const a of links) {
        let href = a.getAttribute('href');
        if (!href || href.startsWith('?') || href.startsWith('/')) continue;
        if (href === '../') continue;
        if (href.endsWith('/')) {
          // Only include allowed folders at root
          const folder = href.replace(/\/$/, '');
          if (MIRROR_INCLUDE_FOLDERS.includes(folder)) {
            subdirPromises.push(fetchAllFilesRecursive(mirror, folder + '/'));
          }
        }
      }
      const subdirFiles = await Promise.allSettled(subdirPromises);
      for (const result of subdirFiles) {
        if (result.status === 'fulfilled') {
          files = files.concat(result.value);
        } else {
          addLog(`Failed to list ${url}: ${result.reason && result.reason.message ? result.reason.message : result.reason}`);
        }
      }
    } catch (err) {
      addLog(`Failed to list ${url}: ${err.message}`);
    }
    return files;
  }

  // Regular recursive scan for files and directories
  let files = [];
  try {
    const res = await dirPool(() =>
      axios.get(url, { timeout: DIR_LIST_TIMEOUT }).catch(e => { throw e; })
    );
    const dom = new JSDOM(res.data);
    const links = [...dom.window.document.querySelectorAll('a')];
    const subdirPromises = [];
    for (const a of links) {
      let href = a.getAttribute('href');
      if (!href || href.startsWith('?') || href.startsWith('/')) continue;
      if (href === '../') continue;
      const fullPath = path.posix.join(basePath, href);
      if (href.endsWith('/')) {
        subdirPromises.push(fetchAllFilesRecursive(mirror, fullPath));
      } else {
        files.push({ mirror, relPath: fullPath });
      }
    }
    const subdirFiles = await Promise.allSettled(subdirPromises);
    for (const result of subdirFiles) {
      if (result.status === 'fulfilled') {
        files = files.concat(result.value);
      } else {
        addLog(`Failed to list ${url}: ${result.reason && result.reason.message ? result.reason.message : result.reason}`);
      }
    }
  } catch (err) {
    addLog(`Failed to list ${url}: ${err.message}`);
  }
  return files;
}

// Download a single file, preserving the full relative path
async function downloadMirrorFile(fileObj, mirrors, workerId = 0, perThreadSpeedLimitKbps = -1) {
  let lastError;
  for (const mirror of mirrors) {
    const url = mirror.replace(/\/+$/, '') + '/' + fileObj.relPath.replace(/^\//, '');
    const localPath = path.join(__dirname, 'mirror', fileObj.relPath);

    // Check if file exists and is up-to-date
    if (await fs.pathExists(localPath)) {
      return;
    }

    try {
      addLog(`Worker #${workerId + 1}: Downloading ${fileObj.relPath} from ${mirror}...`);
      await fs.ensureDir(path.dirname(localPath));
      const res = await axios.get(url, { responseType: 'stream', timeout: 30000 });
      const writer = fs.createWriteStream(localPath);

      // Throttle if needed
      if (perThreadSpeedLimitKbps > 0) {
        const stream = res.data;
        let bytesThisSecond = 0;
        let throttleLastTime = Date.now();
        stream.on('data', chunk => {
          bytesThisSecond += chunk.length;
          const now = Date.now();
          if (bytesThisSecond > perThreadSpeedLimitKbps * 1024) {
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
      addLog(`Worker #${workerId + 1}: Downloaded ${fileObj.relPath} from ${mirror}`);
      return;
    } catch (err) {
      lastError = err;
      addLog(`Worker #${workerId + 1}: Failed to download ${fileObj.relPath} from ${mirror}: ${err.message}`);
    }
  }
  addLog(`Worker #${workerId + 1}: Failed to download ${fileObj.relPath} from all mirrors.`);
  throw lastError;
}

// Main sync logic (recursive, full mirror)
async function syncMirror() {
  if (syncState.running) return;
  syncState.running = true;
  syncAbortController.stop = false;
  syncState.currentTasks = [];
  syncState.currentWorkers = 0;
  syncState.currentTask = 'Scanning mirror...';
  broadcastState();

  // Fetch all files from the first mirror (full recursive)
  let allFiles = [];
  try {
    allFiles = await fetchAllFilesRecursive(MIRRORS[0]);
  } catch (err) {
    addLog(`Failed to fetch file list: ${err.message}`);
  }
  syncState.total = allFiles.length;
  syncState.progress = 0;
  syncState.currentTask = 'Syncing';
  syncState.timeSpent = 0;
  syncState.progressBar = 0;
  syncState.estimatedSizeIncrease = 0;
  syncState.estimatedSizeIncreaseReady = false;
  broadcastState();

  // Start size estimation in the background (optional, can be skipped for performance)
  // estimateSizeIncrease(allFiles);

  let startTime = Date.now();

  if (MULTITHREADED && MIRRORS.length > 1) {
    let fileQueue = allFiles.filter(fileObj => {
      const localPath = path.join(__dirname, 'mirror', fileObj.relPath);
      return !fs.existsSync(localPath);
    });
    let progress = 0;
    let total = fileQueue.length;
    let perThreadSpeedLimit = DOWNLOAD_SPEED_LIMIT_KBPS > 0
      ? Math.floor(DOWNLOAD_SPEED_LIMIT_KBPS / MIRRORS.length)
      : -1;

    // Assign files to each mirror in round-robin
    let mirrorQueues = MIRRORS.map(() => []);
    for (let i = 0; i < fileQueue.length; i++) {
      mirrorQueues[i % MIRRORS.length].push(fileQueue[i]);
    }

    // Download in parallel
    await Promise.all(MIRRORS.map(async (mirror, idx) => {
      addLog(`Worker #${idx + 1} spawned for mirror: ${mirror}`);
      for (const fileObj of mirrorQueues[idx]) {
        if (syncAbortController.stop) break;
        syncState.progress = ++progress;
        syncState.currentWorkers = syncState.currentTasks.filter(Boolean).length;
        syncState.currentTasks[idx] = fileObj.relPath;
        syncState.currentTask = syncState.currentTasks.filter(Boolean).join(', ') || 'Idle';
        // Estimate ETA
        const elapsed = (Date.now() - startTime) / 1000;
        syncState.timeSpent = Math.round(elapsed);
        const avgPerFile = elapsed / (progress);
        syncState.eta = Math.round(avgPerFile * (total - progress));
        syncState.progressBar = Math.round((progress / total) * 100);
        broadcastState();
        try {
          await downloadMirrorFile(fileObj, MIRRORS, idx, perThreadSpeedLimit);
        } catch (err) {
          // Already logged
        }
        syncState.currentWorkers = syncState.currentTasks.filter(Boolean).length;
        syncState.currentTasks[idx] = null;
        syncState.currentTask = syncState.currentTasks.filter(Boolean).join(', ') || 'Idle';
        broadcastState();
        await sleep(TIMEOUT_MS);
      }
      addLog(`Worker #${idx + 1} killed for mirror: ${mirror}`);
    }));
    syncState.progress = total;
    syncState.progressBar = 100;
    syncState.currentTasks = [];
    syncState.currentWorkers = 0;
    syncState.currentTask = 'Idle';
  } else {
    // Single-threaded (original logic)
    for (let i = 0; i < allFiles.length; i++) {
      if (syncAbortController.stop) break;
      const fileObj = allFiles[i];
      syncState.progress = i + 1;
      syncState.currentTasks = [fileObj.relPath];
      syncState.currentWorkers = 1;
      syncState.currentTask = fileObj.relPath;
      // Estimate ETA
      const elapsed = (Date.now() - startTime) / 1000;
      syncState.timeSpent = Math.round(elapsed);
      const avgPerFile = elapsed / (i + 1);
      syncState.eta = Math.round(avgPerFile * (allFiles.length - (i + 1)));
      syncState.progressBar = Math.round(((i + 1) / allFiles.length) * 100);
      broadcastState();
      try {
        addLog(`Worker #1 spawned for mirror: ${MIRRORS[0]}`);
        await downloadMirrorFile(fileObj, MIRRORS, 0, DOWNLOAD_SPEED_LIMIT_KBPS);
        addLog(`Worker #1 killed for mirror: ${MIRRORS[0]}`);
      } catch (err) {
        // error already logged in downloadFile
      }
      syncState.currentTasks = [];
      syncState.currentWorkers = 0;
      syncState.currentTask = 'Idle';
      broadcastState();
      await sleep(TIMEOUT_MS);
    }
  }
  syncState.currentTask = syncAbortController.stop ? 'Stopped by user' : 'Idle';
  syncState.eta = 0;
  syncState.running = false;
  syncState.progressBar = 100;
  syncState.currentFileSpeed = 0;
  syncState.currentTasks = [];
  syncState.currentWorkers = 0;
  broadcastState();
  addLog('Sync complete.');
}

if (process.env.AUTO_START !== 'false') {
  syncMirror().catch(err => {
    syncState.currentTask = 'Error';
    syncState.running = false;
    broadcastState();
    console.error('Sync failed:', err);
  });
}
