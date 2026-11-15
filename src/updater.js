'use strict';
// Update check: asks GitHub Releases (electron-updater) whether a newer installer exists and, only after the user agrees, downloads it.
// Packaged builds only; does nothing in dev. Needs build.publish owner/repo in package.json to be real (REPO_OWNER/REPO_NAME = not configured yet).
const { app, dialog } = require('electron');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

function setupUpdater(getWindow, log) {
  if (!app.isPackaged) return null;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch (error) { log('updater_error', { state: 'load_failed', error: String(error.message).slice(0, 120) }); return null; }
  try {
    const pub = require('../package.json').build?.publish?.[0];
    if (!pub || /^REPO_/.test(pub.owner) || /^REPO_/.test(pub.repo)) { log('updater_error', { state: 'not_configured' }); return null; }
  } catch { return null; }

  autoUpdater.autoDownload = false; // ask first
  autoUpdater.autoInstallOnAppQuit = true; // a downloaded update installs when the app closes
  let asking = false, manual = false, downloaded = false;
  const win = () => { const w = getWindow(); return w && !w.isDestroyed() ? w : undefined; };
  const box = (opts) => (win() ? dialog.showMessageBox(win(), opts) : dialog.showMessageBox(opts));

  autoUpdater.on('update-available', async (info) => {
    if (asking || downloaded) return;
    asking = true;
    try {
      const { response } = await box({
        type: 'info', buttons: ['Download now', 'Later'], defaultId: 0, cancelId: 1, title: 'Update available',
        message: `A new version of YouTube Music Studio is available (${info.version}).`,
        detail: `You have ${app.getVersion()}. Download it now? It installs when you close the app, or right away if you choose to restart.`,
      });
      if (response === 0) { log('updater', { state: 'download_started', version: info.version }); autoUpdater.downloadUpdate().catch((e) => log('updater_error', { state: 'download_failed', error: String(e.message).slice(0, 120) })); }
    } finally { asking = false; }
  });
  autoUpdater.on('update-not-available', async () => {
    if (!manual) return; manual = false;
    await box({ type: 'info', buttons: ['OK'], title: 'No updates', message: `YouTube Music Studio ${app.getVersion()} is up to date.` });
  });
  autoUpdater.on('download-progress', (p) => { win()?.setProgressBar(Math.max(0, Math.min(1, (p.percent || 0) / 100))); });
  autoUpdater.on('update-downloaded', async (info) => {
    downloaded = true; win()?.setProgressBar(-1);
    const { response } = await box({
      type: 'info', buttons: ['Restart and install', 'Install when I close the app'], defaultId: 0, cancelId: 1, title: 'Update ready',
      message: `Version ${info.version} is downloaded.`,
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on('error', (error) => { win()?.setProgressBar(-1); log('updater_error', { state: 'check_failed', error: String(error?.message || error).slice(0, 160) }); manual = false; });

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 10_000); // not during startup
  setInterval(check, CHECK_EVERY_MS).unref?.();
  return { checkNow: () => { manual = true; return autoUpdater.checkForUpdates().catch(() => { manual = false; }); } };
}

module.exports = { setupUpdater };
