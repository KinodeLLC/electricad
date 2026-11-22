// ElectriCAD — main process. Window, IPC surface, and the wiring between the
// renderer and the hardware-facing modules. Everything hardware lives on this
// side; the renderer only ever talks IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const settings = require('./settings');
const projects = require('./projects');
const arduino = require('./arduino');
const serialbridge = require('./serialbridge');
const pigpio = require('./pigpio');
const ai = require('./ai');
const detect = require('./detect');
const catalog = require('./catalog');
const partsdb = require('./partsdb');
const bugreport = require('./bugreport');
const upy = require('./upy');
const git = require('./git');
const localhistory = require('./localhistory');

let win = null;
let forceClose = false;

// one ElectriCAD at a time: two instances would fight over the same serial
// ports and arduino-cli data dir. A second launch focuses the first window.
const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}

function createWindow() {
  const saved = settings.get('window') || {};
  win = new BrowserWindow({
    width: saved.width || 1560,
    height: saved.height || 940,
    x: Number.isFinite(saved.x) ? saved.x : undefined,
    y: Number.isFinite(saved.y) ? saved.y : undefined,
    minWidth: 1100,
    minHeight: 660,
    backgroundColor: '#121212',
    autoHideMenuBar: true,
    show: false,
    title: 'ElectriCAD',
    icon: path.join(__dirname, '..', 'assets', 'electricad.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // ElectriCAD is built to run fullscreen: that is the default, F11 toggles it,
  // and leaving it lands on a maximized window
  if (saved.maximized || saved.fullscreen !== false) win.maximize();
  if (saved.fullscreen !== false) win.setFullScreen(true);
  win.once('ready-to-show', () => win.show());
  const tellFull = () => { send('win:fullscreen', win.isFullScreen()); rememberBounds(); };
  win.on('enter-full-screen', tellFull);
  win.on('leave-full-screen', () => { if (!win.isMaximized()) win.maximize(); tellFull(); });
  win.webContents.on('did-finish-load', () => send('win:fullscreen', win.isFullScreen()));
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // links the renderer opens (catalog pages, docs) go to the real browser,
  // never into an Electron window with our preload attached
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  // remember size/position across launches
  let boundsT = null;
  const rememberBounds = () => {
    clearTimeout(boundsT);
    boundsT = setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      const fullscreen = win.isFullScreen();
      const maximized = fullscreen || win.isMaximized();
      const b = maximized ? (settings.get('window') || {}) : win.getBounds();
      settings.set({ window: { x: b.x, y: b.y, width: b.width, height: b.height, maximized, fullscreen } });
    }, 400);
  };
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  win.on('maximize', rememberBounds);
  win.on('unmaximize', rememberBounds);

  // unsaved-work guard: the renderer owns the dirty state, so closing asks
  // it first. If the renderer never acknowledges (hung page), close anyway.
  win.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    send('app:closeRequest');
    clearTimeout(win._closeT);
    win._closeT = setTimeout(() => { forceClose = true; if (win) win.close(); }, 2500);
  });
  win.on('closed', () => { win = null; });
}

ipcMain.handle('app:win', (e, what) => {
  if (!win) return false;
  if (what === 'fullscreen') win.setFullScreen(!win.isFullScreen());
  else if (what === 'minimize') win.minimize();
  else if (what === 'close') win.close();
  return win.isFullScreen();
});
ipcMain.on('app:closeAck', () => { if (win) clearTimeout(win._closeT); });
ipcMain.on('app:closeConfirmed', () => { forceClose = true; if (win) win.close(); });

// ---- application menu -------------------------------------------------------
// The default Electron menu binds Ctrl+R to "reload page" — which silently
// threw away unsaved code every time someone hit Verify. Our own menu routes
// every accelerator to the renderer's command table instead.
function buildMenu() {
  const cmd = (id) => () => send('menu:command', id);
  const item = (label, id, accelerator) => ({ label, accelerator, click: cmd(id) });
  const template = [
    { label: '&File', submenu: [
      item('New Arduino Sketch…', 'newSketch', 'CmdOrCtrl+N'),
      item('New Raspberry Pi Project…', 'newPi'),
      item('New MicroPython Project…', 'newMicroPython'),
      item('New CircuitPython Project…', 'newCircuitPython'),
      item('New from Example…', 'examples', 'CmdOrCtrl+Shift+E'),
      item('Library Examples…', 'libExamples'),
      item('New Class (.h + .cpp)…', 'newClass'),
      { type: 'separator' },
      item('Open Project…', 'openProject', 'CmdOrCtrl+O'),
      item('Open Folder / Arduino Sketch…', 'openFolder'),
      { type: 'separator' },
      item('Rename Project…', 'renameProject'),
      item('Duplicate Project…', 'duplicateProject'),
      item('Archive Project as .zip…', 'archiveProject'),
      { type: 'separator' },
      item('New File…', 'newFile', 'CmdOrCtrl+Alt+N'),
      item('Save', 'save', 'CmdOrCtrl+S'),
      item('Save All', 'saveAll', 'CmdOrCtrl+Shift+S'),
      item('Close Tab', 'closeTab', 'CmdOrCtrl+W'),
      item('Close Other Tabs', 'closeOthers'),
      item('Close All Tabs', 'closeAll'),
      item('Reopen Closed Tab', 'reopenTab', 'CmdOrCtrl+Shift+T'),
      item('Next Tab', 'nextTab', 'CmdOrCtrl+Tab'),
      item('Previous Tab', 'prevTab', 'CmdOrCtrl+Shift+Tab'),
      { type: 'separator' },
      item('Settings', 'settings', 'CmdOrCtrl+,'),
      item('Export Settings…', 'exportSettings'),
      item('Import Settings…', 'importSettings'),
      item('Reset Settings…', 'resetSettings'),
      { type: 'separator' },
      { role: 'quit', label: 'Exit' }
    ] },
    { label: '&Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      { type: 'separator' },
      item('Find', 'find', 'CmdOrCtrl+F'),
      item('Replace', 'replace', 'CmdOrCtrl+H'),
      item('Go to Line…', 'gotoLine', 'CmdOrCtrl+G'),
      { type: 'separator' },
      item('Find in Project…', 'findInProject', 'CmdOrCtrl+Shift+F'),
      item('TODO / FIXME List', 'todos'),
      item('Go to File…', 'quickOpen', 'CmdOrCtrl+P'),
      item('Format Document', 'format', 'Shift+Alt+F'),
      item('Toggle Line Comment', 'toggleComment', 'CmdOrCtrl+/'),
      item('Replace in Project…', 'replaceInProject', 'CmdOrCtrl+Shift+H'),
      item('Go to Symbol in File…', 'goToSymbol', 'CmdOrCtrl+Shift+O'),
      item('Go to Definition', 'goToDefinition'),
      item('Jump to Matching Bracket', 'jumpBracket'),
      { label: 'Lines', submenu: [
        item('Duplicate Selection', 'duplicateSelection'),
        item('Delete Line', 'deleteLine', 'CmdOrCtrl+Shift+K'),
        item('Join Lines', 'joinLines'),
        item('Sort Lines Ascending', 'sortLines'),
        item('Sort Lines Descending', 'sortLinesDesc'),
        item('UPPER CASE', 'upperCase'),
        item('lower case', 'lowerCase'),
        item('Column (Box) Selection', 'columnSelection')
      ] },
      { type: 'separator' },
      item('Local History of This File…', 'localHistory'),
      item('Compare with Saved', 'compareWithSaved'),
      item('Compare with Another File…', 'compareFiles'),
      item('Markdown Preview', 'markdownPreview'),
      item('Command Palette…', 'palette', 'CmdOrCtrl+Shift+P')
    ] },
    { label: '&Sketch', submenu: [
      item('Verify / Compile', 'verify', 'CmdOrCtrl+R'),
      item('Upload', 'upload', 'CmdOrCtrl+U'),
      item('Cancel Build', 'cancelBuild'),
      item('Clean Build (rebuild everything)', 'cleanBuild'),
      item('Export Compiled Binary (.hex/.bin/.uf2)', 'exportBinary', 'CmdOrCtrl+Alt+S'),
      item('Upload the Last Build (no recompile)', 'uploadLast', 'CmdOrCtrl+Alt+U'),
      item('Build for Several Boards…', 'multiBuild'),
      item('Build Flags and Defines…', 'buildFlags'),
      item('Open Build Folder', 'openBuildFolder'),
      { type: 'separator' },
      item('Upload Using Programmer', 'uploadProgrammer', 'CmdOrCtrl+Shift+U'),
      item('Burn Bootloader…', 'burnBootloader'),
      { type: 'separator' },
      item('Select Board…', 'selectBoard', 'CmdOrCtrl+Shift+B'),
      item('Board Options…', 'boardOptions', 'CmdOrCtrl+Alt+O'),
      item('Board Info', 'boardInfo'),
      item('Include Library…', 'includeLib'),
      item('Install a Library Version…', 'libVersion'),
      item('Installed Library Details…', 'libDetails'),
      item('Check Pins Against Board', 'pinCheck', 'CmdOrCtrl+Alt+P'),
      item('Devices…', 'devices', 'CmdOrCtrl+Shift+D'),
      item('Add Live Telemetry to Sketch', 'addTelemetry'),
      { type: 'separator' },
      item('Show Sketch Folder', 'revealProject', 'CmdOrCtrl+K')
    ] },
    { label: '&Python', submenu: [
      item('Run on Board (MicroPython/CircuitPython)', 'upyRun', 'F5'),
      item('Stop Program (Ctrl+C)', 'upyStop', 'Shift+F5'),
      item('Run Selection on Board', 'upyRunSel', 'F6'),
      item('Soft Reset Board', 'upySoftReset'),
      { type: 'separator' },
      item('Upload as main.py / code.py', 'upyUpload'),
      item('Upload This File Only', 'upyUploadCurrent'),
      item('New Folder on Board…', 'upyMkdir'),
      item('Get Firmware…', 'pyFirmware'),
      item('Board Files…', 'upyFiles'),
      item('Download All Board Files to Project', 'upyDownloadAll'),
      item('Set Board Clock to PC Time', 'upySetClock'),
      item('Open CIRCUITPY Drive', 'cpyOpenDrive'),
      item('Board Info', 'upyInfo')
    ] },
    { label: '&Tools', submenu: [
      item('Serial Monitor', 'panel:serial', 'CmdOrCtrl+Shift+M'),
      item('Serial Plotter', 'panel:plotter', 'CmdOrCtrl+Shift+L'),
      item('Pin Timeline', 'panel:timeline'),
      item('I2C Bus', 'panel:i2c'),
      item('Send File to Serial…', 'serialSendFile'),
      item('Quick-Send Commands…', 'serialMacros', 'CmdOrCtrl+Alt+M'),
      item('Copy Serial Output', 'serialCopy'),
      item('Reset Board (DTR pulse)', 'resetBoard'),
      { type: 'separator' },
      item('ElectriCAD Canvas', 'wiring', 'CmdOrCtrl+Shift+W'),
      item('PCB Layout', 'pcb', 'CmdOrCtrl+Shift+X'),
      { label: 'Manufacturing', submenu: [
        item('Manufacturing Overview…', 'manufacturing'),
        item('Order PCBs from a Gerber Zip…', 'orderFromZip'),
        item('Preview a Gerber Zip…', 'gerberPreview'),
        item('Export BOM…', 'exportBom'),
        item('Export Netlist…', 'exportNetlist'),
        item('Export Pick-and-Place (CPL)', 'exportCpl')
      ] },
      item('Adafruit Catalog', 'catalog'),
      item('Electronics Calculators', 'calc', 'CmdOrCtrl+Alt+C'),
      item('Board Pinout', 'pinout', 'CmdOrCtrl+Alt+I'),
      item('Image to C Array…', 'imageToC'),
      item('Find a Datasheet…', 'datasheet'),
      item('Arduino Reference for the Word at the Cursor', 'arduinoReference', 'CmdOrCtrl+Alt+R'),
      { type: 'separator' },
      item('AI: New Sketch from a Description…', 'aiGenerate'),
      item('AI: Save Chat as Markdown…', 'aiSaveChat'),
      item('Library Manager', 'libs', 'CmdOrCtrl+Shift+I'),
      item('Add .ZIP Library…', 'libZip'),
      item('Update All Libraries', 'libUpgradeAll'),
      item('Update All Board Cores', 'coreUpgradeAll'),
      { type: 'separator' },
      item('Connect Raspberry Pi…', 'connectPi'),
      item('Close All Serial Ports', 'closePorts')
    ] },
    { label: '&View', submenu: [
      item('Toggle Side Bar', 'toggleSide', 'CmdOrCtrl+B'),
      item('Toggle Bottom Panel', 'toggleBottom', 'CmdOrCtrl+J'),
      item('Toggle Board && AI Pane', 'toggleRight', 'CmdOrCtrl+Alt+B'),
      item('Source Control', 'git', 'CmdOrCtrl+Shift+G'),
      item('Toggle Light / Dark Theme', 'toggleTheme', 'CmdOrCtrl+Alt+T'),
      item('Zen Mode (editor only)', 'zen', 'CmdOrCtrl+Alt+Z'),
      item('Toggle Word Wrap', 'wordWrap', 'Alt+Z'),
      item('Toggle Minimap', 'minimap'),
      { type: 'separator' },
      { role: 'zoomIn', label: 'Zoom Interface In', accelerator: 'CmdOrCtrl+Shift+=' },
      { role: 'zoomOut', label: 'Zoom Interface Out', accelerator: 'CmdOrCtrl+Shift+-' },
      { role: 'resetZoom', label: 'Reset Interface Zoom', accelerator: 'CmdOrCtrl+Shift+0' },
      { type: 'separator' },
      item('Editor Font Larger', 'fontUp', 'CmdOrCtrl+='),
      item('Editor Font Smaller', 'fontDown', 'CmdOrCtrl+-'),
      item('Reset Editor Font', 'fontReset', 'CmdOrCtrl+0'),
      { type: 'separator' },
      { role: 'togglefullscreen', label: 'Full Screen', accelerator: 'F11' },
      { label: 'Reload Window', accelerator: 'CmdOrCtrl+Shift+F5', click: cmd('reload') },
      { role: 'toggleDevTools', accelerator: 'F12' }
    ] },
    { label: '&Help', submenu: [
      item('ElectriCAD Guide', 'guide'),
      item('What\'s New', 'whatsNew'),
      item('Keyboard Shortcuts', 'shortcuts', 'F1'),
      item('Live Telemetry Guide', 'telemetryHelp'),
      { type: 'separator' },
      item('Report a Bug…', 'reportBug'),
      { label: 'Report Page on usekinode.app', click: () => shell.openExternal('https://usekinode.app/products/electricad') },
      { type: 'separator' },
      { label: 'arduino-cli Documentation', click: () => shell.openExternal('https://arduino.github.io/arduino-cli/latest/') },
      { label: 'Arduino Language Reference', click: () => shell.openExternal('https://docs.arduino.cc/language-reference/') },
      { label: 'Adafruit Learning System', click: () => shell.openExternal('https://learn.adafruit.com/') },
      { type: 'separator' },
      item('About ElectriCAD', 'about')
    ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- broadcast helpers -----------------------------------------------------
function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
serialbridge.on('data', (d) => send('serial:data', d));
serialbridge.on('telemetry', (t) => send('pins:telemetry', t));
serialbridge.on('i2c', (t) => send('i2c:scan', t));
serialbridge.on('status', (s) => send('serial:status', s));
pigpio.on('telemetry', (t) => send('pins:telemetry', t));
pigpio.on('status', (s) => send('pi:status', s));
arduino.on('progress', (p) => send('toolchain:progress', p));
detect.on('devices', (d) => send('devices:update', d));

// ---- IPC surface -----------------------------------------------------------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(), electron: process.versions.electron,
  chrome: process.versions.chrome, node: process.versions.node,
  platform: process.platform, userData: app.getPath('userData')
}));
ipcMain.handle('app:reload', () => { if (win) win.webContents.reloadIgnoringCache(); });

// settings
ipcMain.handle('settings:get', () => settings.all());
ipcMain.handle('settings:set', (e, patch) => settings.set(patch));
ipcMain.handle('settings:reset', () => settings.reset());

// projects / files
ipcMain.handle('project:list', () => projects.list());
ipcMain.handle('project:create', (e, opts) => projects.create(opts));
ipcMain.handle('project:open', (e, dir) => projects.open(dir));
ipcMain.handle('project:tree', (e, dir) => projects.tree(dir));
ipcMain.handle('project:update', (e, dir, patch) => projects.updateManifest(dir, patch));
ipcMain.handle('project:examples', () => projects.examples());
ipcMain.handle('project:forget', (e, dir) => projects.forget(dir));
ipcMain.handle('file:read', (e, p) => fs.promises.readFile(p, 'utf8'));
ipcMain.handle('file:write', async (e, p, content) => {
  if (typeof content === 'string' && content.length < 2 * 1024 * 1024 && !/[\\/](wiring|pcb)\.json$|electricad\.json$/.test(p)) {
    try { localhistory.snapshot(p, content); } catch (err) { /* history is best-effort */ }
  }
  // write-then-rename so a crash mid-save never leaves a half-written sketch
  const tmp = p + '.electricad-tmp';
  try {
    await fs.promises.writeFile(tmp, content, 'utf8');
    await fs.promises.rename(tmp, p);
  } catch (err) {
    fs.promises.unlink(tmp).catch(() => {});
    await fs.promises.writeFile(p, content, 'utf8');
  }
  return true;
});
ipcMain.handle('file:create', (e, p) => projects.createFile(p));
ipcMain.handle('file:mkdir', (e, p) => { fs.mkdirSync(p, { recursive: true }); return true; });
ipcMain.handle('file:exists', (e, p) => fs.existsSync(p));
ipcMain.handle('file:rename', (e, from, to) => projects.renamePath(from, to));
ipcMain.handle('file:trash', async (e, p) => { await shell.trashItem(p); return true; });
ipcMain.handle('file:reveal', (e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('dialog:openFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('app:capture', async (e, rect, file) => {
  const img = await win.webContents.capturePage(rect);
  await fs.promises.writeFile(file, img.toPNG());
  return true;
});
ipcMain.handle('file:writeBase64', async (e, p, b64) => {
  await fs.promises.writeFile(p, Buffer.from(String(b64), 'base64'));
  return true;
});
ipcMain.handle('dialog:saveFile', async (e, opts) => {
  const r = await dialog.showSaveDialog(win, {
    defaultPath: (opts && opts.defaultPath) || undefined,
    filters: (opts && opts.filters) || undefined
  });
  return r.canceled ? null : r.filePath;
});

ipcMain.handle('dialog:openFile', async (e, opts) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: (opts && opts.filters) || undefined });
  return r.canceled ? null : r.filePaths[0];
});

// toolchain
ipcMain.handle('toolchain:ensure', () => arduino.ensureCli());
ipcMain.handle('libs:updatable', () => arduino.libUpdatable());
ipcMain.handle('libs:upgradeAll', () => arduino.libUpgradeAll());
ipcMain.handle('libs:installZip', (e, p) => arduino.libInstallZip(p));
ipcMain.handle('cores:upgradeAll', () => arduino.coreUpgradeAll());

// micropython / circuitpython
ipcMain.handle('upy:run', (e, port, code) => upy.run(port, code));
ipcMain.handle('upy:upload', (e, port, name, code) => upy.upload(port, name, code));
ipcMain.handle('upy:ls', (e, port) => upy.listFiles(port));
ipcMain.handle('upy:read', (e, port, name) => upy.readFile(port, name));
ipcMain.handle('upy:rm', (e, port, name) => upy.removeFile(port, name));
ipcMain.handle('upy:info', (e, port) => upy.info(port));
ipcMain.handle('upy:interrupt', (e, port) => upy.interrupt(port));
ipcMain.handle('upy:softReset', (e, port) => upy.softReset(port));
ipcMain.handle('cpy:drives', () => upy.circuitpyDrives());
ipcMain.handle('cpy:copy', (e, root, name, content) => upy.copyToDrive(root, name, content));

// git
ipcMain.handle('git:status', (e, dir) => git.status(dir));
ipcMain.handle('git:init', (e, dir) => git.init(dir));
ipcMain.handle('git:diff', (e, dir, file, staged) => git.diff(dir, file, staged));
ipcMain.handle('git:show', (e, dir, file) => git.show(dir, file));
ipcMain.handle('git:stage', (e, dir, files) => git.stage(dir, files));
ipcMain.handle('git:unstage', (e, dir, files) => git.unstage(dir, files));
ipcMain.handle('git:commit', (e, dir, msg, all) => git.commit(dir, msg, all));
ipcMain.handle('git:log', (e, dir, n) => git.log(dir, n));
ipcMain.handle('git:identity', (e, dir) => git.identity(dir));
ipcMain.handle('git:setIdentity', (e, name, email) => git.setIdentity(name, email));
ipcMain.handle('boards:list', () => arduino.boardList());
ipcMain.handle('boards:all', () => arduino.knownBoards());
ipcMain.handle('cores:installed', () => arduino.coreList());
ipcMain.handle('cores:install', (e, id) => arduino.coreInstall(id));
ipcMain.handle('cores:uninstall', (e, id) => arduino.coreUninstall(id));
ipcMain.handle('libs:search', (e, q) => arduino.libSearch(q));
ipcMain.handle('libs:install', (e, name) => arduino.libInstall(name));
ipcMain.handle('libs:uninstall', (e, name) => arduino.libUninstall(name));
ipcMain.handle('libs:installed', () => arduino.libList());
ipcMain.handle('build:compile', (e, opts) => arduino.compile(opts));
ipcMain.handle('build:upload', (e, opts) => arduino.upload(opts));
ipcMain.handle('build:uploadProgrammer', (e, opts) => arduino.uploadProgrammer(opts));
ipcMain.handle('build:burnBootloader', (e, opts) => arduino.burnBootloader(opts));
ipcMain.handle('toolchain:version', () => arduino.cliVersion());
ipcMain.handle('app:progress', (e, v) => { if (win) win.setProgressBar(v == null || v < 0 ? -1 : v); return true; });
ipcMain.handle('upy:readB64', (e, port, name) => upy.readFileB64(port, name));
ipcMain.handle('upy:setClock', (e, port, when) => upy.setClock(port, when));
ipcMain.handle('git:discard', (e, dir, files) => git.discard(dir, files));
ipcMain.handle('git:branches', (e, dir) => git.branches(dir));
ipcMain.handle('git:createBranch', (e, dir, name) => git.createBranch(dir, name));
ipcMain.handle('git:switchBranch', (e, dir, name) => git.switchBranch(dir, name));
ipcMain.handle('boards:details', (e, fqbn) => arduino.boardDetails(fqbn));
ipcMain.handle('libs:examples', (e, fqbn) => arduino.libExamples(fqbn));
ipcMain.handle('build:cancel', () => arduino.cancel());
// v0.9
ipcMain.handle('libs:versions', (e, name) => arduino.libVersions(name));
ipcMain.handle('libs:installVersion', (e, name, version) => arduino.libInstall(name, version));
ipcMain.handle('boards:applyUrls', () => arduino.applyBoardUrls());
ipcMain.handle('project:rename', (e, dir, name) => projects.renameProject(dir, name));
ipcMain.handle('project:duplicate', (e, dir, name) => projects.duplicateProject(dir, name));
ipcMain.handle('project:archive', (e, dir, zip) => projects.archiveProject(dir, zip));
ipcMain.handle('project:pin', (e, dir, on) => projects.setPinned(dir, on));
ipcMain.handle('file:readBase64', async (e, p) => (await fs.promises.readFile(p)).toString('base64'));
ipcMain.handle('file:append', async (e, p, text) => { await fs.promises.appendFile(p, String(text), 'utf8'); return true; });
ipcMain.handle('file:stat', async (e, p) => { const st = await fs.promises.stat(p); return { size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() }; });
ipcMain.handle('file:list', async (e, dir) => (await fs.promises.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, dir: d.isDirectory() })));
ipcMain.handle('file:openPath', async (e, p) => { const err = await shell.openPath(p); if (err) throw new Error(err); return true; });
ipcMain.handle('history:list', (e, p) => localhistory.list(p));
ipcMain.handle('history:read', (e, p, id) => localhistory.read(p, id));
ipcMain.handle('hot:save', (e, bufs) => localhistory.hotSave(bufs));
ipcMain.handle('hot:load', () => localhistory.hotLoad());
ipcMain.handle('hot:clear', () => localhistory.hotClear());
ipcMain.handle('zip:list', async (e, p) => {
  const zip = require('./zip');
  const entries = zip.read(await fs.promises.readFile(p));
  // text of the small files (Gerbers, drill) so the renderer can check them
  return entries.filter((x) => !x.dir).map((x) => ({ name: x.name, size: x.size,
    text: x.size < 8 * 1024 * 1024 ? x.read().toString('latin1') : null }));
});
ipcMain.handle('zip:write', async (e, p, files) => {
  const zip = require('./zip');
  await fs.promises.writeFile(p, zip.build((files || []).map((f) => ({ name: f.name, data: f.b64 != null ? Buffer.from(f.b64, 'base64') : String(f.text || '') }))));
  return { ok: true, path: p, bytes: (await fs.promises.stat(p)).size };
});
ipcMain.handle('serial:signals', (e, p, sig) => serialbridge.setSignals(p, sig || {}));
ipcMain.handle('upy:mkdir', (e, port, name) => upy.mkdir(port, name));
ipcMain.handle('upy:syntax', (e, port, name, code) => upy.syntaxCheck(port, name, code));
ipcMain.handle('cpy:copyDir', (e, root, src, sub) => upy.copyDirToDrive(root, src, sub));
ipcMain.handle('git:remotes', (e, dir) => git.remotes(dir));
ipcMain.handle('git:setRemote', (e, dir, url) => git.setRemote(dir, url));
ipcMain.handle('git:push', (e, dir) => git.push(dir));
ipcMain.handle('git:pull', (e, dir) => git.pull(dir));
ipcMain.handle('git:fetch', (e, dir) => git.fetch(dir));
ipcMain.handle('git:commitDetails', (e, dir, h) => git.commitDetails(dir, h));
ipcMain.handle('git:blame', (e, dir, f) => git.blame(dir, f));
ipcMain.handle('app:notify', (e, title, body) => {
  const { Notification } = require('electron');
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || 'ElectriCAD'), body: String(body || '') });
  n.on('click', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  n.show();
  return true;
});
ipcMain.handle('app:setTitle', (e, t) => { if (win) win.setTitle(String(t || 'ElectriCAD')); return true; });
ipcMain.handle('app:docs', async (e, name) => {
  if (!/^[A-Za-z0-9_-]+\.md$/.test(String(name))) throw new Error('bad doc');
  const p = [path.join(__dirname, '..', 'docs', name), path.join(__dirname, '..', name)].find((x) => fs.existsSync(x));
  if (!p) throw new Error('not found');
  return fs.promises.readFile(p, 'utf8');
});

// serial (multi-port)
ipcMain.handle('serial:ports', () => serialbridge.listPorts());
ipcMain.handle('serial:open', (e, opts) => serialbridge.open(opts));
ipcMain.handle('serial:close', (e, p) => serialbridge.close(p));
ipcMain.handle('serial:writeLine', (e, p, line, ending) => serialbridge.writeLine(p, line, ending));
ipcMain.handle('serial:setBaud', (e, p, baud) => serialbridge.setBaud(p, baud));
ipcMain.handle('serial:reset', (e, p) => serialbridge.resetBoard(p));
ipcMain.handle('serial:writeRaw', (e, p, bytes) => serialbridge.writeRaw(p, Buffer.from(bytes || [])));

// device detection
ipcMain.handle('devices:list', () => detect.list());

// adafruit parts catalog (offline dataset; refresh = 2 polite API calls)
ipcMain.handle('catalog:stats', () => catalog.stats());
ipcMain.handle('catalog:cats', () => catalog.categories());
ipcMain.handle('catalog:search', (e, opts) => catalog.search(opts || {}));
ipcMain.handle('catalog:get', (e, id) => catalog.get(id));
ipcMain.handle('catalog:refresh', () => catalog.refresh());
// real parts: JLCPCB/LCSC catalogue + KiCad libraries (see main/partsdb.js)
const safe = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { error: e.message || String(e) }; } };
ipcMain.handle('parts:search', safe((e, opts) => partsdb.search(opts || {})));
ipcMain.handle('parts:details', safe((e, lcsc, opts) => partsdb.details(lcsc, opts || {})));
ipcMain.handle('parts:fpSearch', safe((e, q) => partsdb.fpSearch(q)));
ipcMain.handle('parts:fp', safe((e, id) => partsdb.fp(id)));
ipcMain.handle('parts:symSearch', safe((e, q) => partsdb.symSearch(q)));
ipcMain.handle('parts:stats', safe(() => partsdb.stats()));
// bug / wrong-image reports: only when the user presses Send in the report form
ipcMain.handle('bug:send', safe(async (e, report, opts) => {
  const r = { ...(report || {}) };
  if (opts && opts.screenshot) {
    try {
      const img = await e.sender.capturePage();
      const sized = img.getSize().width > 1920 ? img.resize({ width: 1920 }) : img;
      r.screenshot = 'data:image/jpeg;base64,' + sized.toJPEG(82).toString('base64');
    } catch (x) { /* send without it */ }
  }
  return bugreport.send(r, { appVersion: app.getVersion() });
}));
ipcMain.handle('parts:used', safe((e, lcsc) => partsdb.markUsed(lcsc)));

// raspberry pi (network gpio via pigpiod)
ipcMain.handle('pi:connect', (e, opts) => pigpio.connect(opts));
ipcMain.handle('pi:disconnect', () => pigpio.disconnect());
ipcMain.handle('pi:gpioWrite', (e, pin, level) => pigpio.write(pin, level));
ipcMain.handle('pi:setMode', (e, pin, mode) => pigpio.setMode(pin, mode));

// ai — chat is streamed back over ai:chunk events
ipcMain.handle('ai:chat', async (e, req) => ai.chat(req, (chunk) => send('ai:chunk', chunk)));
ipcMain.handle('ai:abort', () => ai.abort());

ipcMain.handle('shell:openExternal', (e, url) => {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('only http(s) links open externally');
  return shell.openExternal(url);
});

if (primary) {
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    // warm the toolchain in the background so first compile isn't a download
    arduino.ensureCli().catch(() => {});
    // continuous board/chip discovery
    detect.start({
      listPorts: () => serialbridge.listPorts(),
      cliBoardList: () => arduino.boardList(),
      piHosts: () => [(settings.get('pi') || {}).host],
      busy: () => arduino.isBusy()
    });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
}
app.on('window-all-closed', () => {
  detect.stop();
  serialbridge.close();
  pigpio.disconnect();
  if (process.platform !== 'darwin') app.quit();
});
