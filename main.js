const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path'), fs = require('fs'), https = require('https');
const crypto = require('crypto'), cp = require('child_process');
const AdmZip = require('adm-zip');
const PT_URL = 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip';
const toolsDir = () => path.join(app.getPath('userData'), 'tools');
const exe = n => process.platform === 'win32' ? n + '.exe' : n;
function bin(n) { const p = path.join(toolsDir(), 'platform-tools', exe(n)); return fs.existsSync(p) ? p : n; }
function run(cmd, args, t = 8000) {
  return new Promise(res => cp.execFile(cmd, args, { timeout: t, windowsHide: true }, (e, so, se) => res({ e, out: (so || '') + (se || '') })));
}
function get(url, dest, onP, left = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && left > 0) {
        r.resume(); return resolve(get(new URL(r.headers.location, url).href, dest, onP, left - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const total = +r.headers['content-length'] || 0, h = crypto.createHash('sha256'), out = fs.createWriteStream(dest);
      let got = 0;
      r.on('data', c => { got += c.length; h.update(c); if (onP && total) onP(Math.floor(got / total * 100)); });
      r.pipe(out);
      out.on('finish', () => out.close(() => resolve(h.digest('hex'))));
      out.on('error', reject); r.on('error', reject);
    }).on('error', reject);
  });
}
function getText(url, left = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && left > 0) {
        r.resume(); return resolve(getText(new URL(r.headers.location, url).href, left - 1));
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      let s = ''; r.setEncoding('utf8'); r.on('data', c => s += c); r.on('end', () => resolve(s));
    }).on('error', reject);
  });
}
async function detect() {
  const a = await run(bin('adb'), ['devices']);
  if (a.e && a.e.code === 'ENOENT') return { error: 'notools' };
  const lines = a.out.split('\n').slice(1).map(s => s.trim()).filter(Boolean);
  if (lines.some(l => /\tunauthorized/.test(l))) return { error: 'unauthorized' };
  if (lines.some(l => /\tdevice$/.test(l))) {
    const g = async k => (await run(bin('adb'), ['shell', 'getprop', k])).out.trim();
    return { brand: await g('ro.product.brand'), device: await g('ro.product.device'), model: await g('ro.product.model') };
  }
  const f = await run(bin('fastboot'), ['devices']);
  if (/fastboot/.test(f.out)) {
    const v = await run(bin('fastboot'), ['getvar', 'product']);
    const m = v.out.match(/product:\s*(\S+)/);
    return { brand: '', device: m ? m[1] : '', model: '' };
  }
  return { error: 'nodevice' };
}
async function installTools() {
  try {
    fs.mkdirSync(toolsDir(), { recursive: true });
    const z = path.join(app.getPath('temp'), 'platform-tools.zip');
    await get(PT_URL, z);
    new AdmZip(z).extractAllTo(toolsDir(), true);
    return { ok: true };
  } catch (e) { return { ok: false }; }
}
async function inspect() {
  const a = await run(bin('adb'), ['devices']);
  if (a.e && a.e.code === 'ENOENT') return { error: 'notools' };
  const ok = a.out.split('\n').slice(1).some(l => /\tdevice$/.test(l.trim()));
  if (!ok) return { error: /unauthorized/.test(a.out) ? 'unauthorized' : 'nodevice' };
  const g = async k => (await run(bin('adb'), ['shell', 'getprop', k])).out.trim();
  return {
    brand: await g('ro.product.brand'), model: await g('ro.product.model'), device: await g('ro.product.device'),
    android: await g('ro.build.version.release'), treble: await g('ro.treble.enabled'),
    abi: await g('ro.product.cpu.abi'), first: await g('ro.product.first_api_level'),
    ab: (await g('ro.build.ab_update')) || (await g('ro.boot.slot_suffix')),
    dynamic: await g('ro.boot.dynamic_partitions'),
    platform: await g('ro.board.platform'), hardware: await g('ro.hardware')
  };
}
ipcMain.handle('inspect', inspect);
ipcMain.handle('detect', detect);
ipcMain.handle('installTools', installTools);
ipcMain.handle('pickStick', async () => {
  const r = await dialog.showOpenDialog({ title: 'Выберите флешку с Ventoy (её корень)', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('download', async (ev, o) => {
  try {
    if (o.fido) {
      const fp = path.join(app.getPath('userData'), 'Fido.ps1');
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      await get('https://raw.githubusercontent.com/pbatard/Fido/master/Fido.ps1', fp);
      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fp, '-Win', o.fido.win, '-Rel', 'Latest', '-Lang', 'Russian', '-Arch', 'x64', '-GetUrl'];
      const r = await run('powershell.exe', args, 120000);
      const u = r.out.split(/\r?\n/).map(s => s.trim()).find(s => /^https:\/\//.test(s));
      if (!u) throw new Error('Microsoft не выдал ссылку (возможно, блок по региону). Ответ: ' + r.out.trim().slice(0, 300));
      o.url = u; o.name = decodeURIComponent(new URL(u).pathname.split('/').pop());
    }
    if (o.resolve) {
      const txt = await getText(o.resolve.base + o.resolve.sums);
      const re = new RegExp('^([0-9a-f]{64})\\s+\\*?(' + o.resolve.re + ')\\s*$', 'gmi');
      const ver = s => ((s.match(/\d+(?:\.\d+)+/) || ['0'])[0]).split('.').map(Number);
      const cmp = (a, b) => { const x = ver(a[2]), y = ver(b[2]); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
      const all = [...txt.matchAll(re)].sort(cmp);
      if (!all.length) throw new Error('Не нашёл актуальный образ на сервере');
      const mt = all[all.length - 1];
      o.sha256 = mt[1]; o.name = mt[2]; o.url = o.resolve.base + mt[2];
    }
    const dir = path.join(o.root, ...o.folder.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    const hash = await get(o.url, path.join(dir, o.name), p => ev.sender.send('progress', { id: o.id, p }));
    return { ok: true, hash, match: o.sha256 ? hash === o.sha256.toLowerCase() : null };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
ipcMain.handle('open', (ev, url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 1000, height: 780, webPreferences: { preload: path.join(__dirname, 'preload.js') } });
  w.setMenuBarVisibility(false);
  w.loadFile(path.join(__dirname, 'app', 'installer.html'));
  w.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
});
app.on('window-all-closed', () => app.quit());
