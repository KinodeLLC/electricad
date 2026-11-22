// The one bridge between renderer and main. Everything is promise-shaped;
// events come through .on(channel, fn) with an unsubscribe returned.
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

const EVENTS = ['serial:data', 'serial:status', 'pins:telemetry', 'pi:status', 'i2c:scan',
                'toolchain:progress', 'ai:chunk', 'devices:update', 'menu:command',
                'app:closeRequest', 'win:fullscreen'];

contextBridge.exposeInMainWorld('electricad', {
  app: {
    info: invoke('app:info'),
    reload: invoke('app:reload'),
    capture: invoke('app:capture'),
    progress: invoke('app:progress'),
    notify: invoke('app:notify'),
    setTitle: invoke('app:setTitle'),
    docs: invoke('app:docs'),
    // the window: fullscreen first (F11 toggles), plus min/close while fullscreen hides the title bar
    win: invoke('app:win'),
    closeAck: () => ipcRenderer.send('app:closeAck'),
    confirmClose: () => ipcRenderer.send('app:closeConfirmed')
  },
  settings: { get: invoke('settings:get'), set: invoke('settings:set'), reset: invoke('settings:reset') },
  project: {
    list: invoke('project:list'),
    create: invoke('project:create'),
    open: invoke('project:open'),
    tree: invoke('project:tree'),
    update: invoke('project:update'),
    examples: invoke('project:examples'),
    forget: invoke('project:forget'),
    rename: invoke('project:rename'),
    duplicate: invoke('project:duplicate'),
    archive: invoke('project:archive'),
    pin: invoke('project:pin'),
    pickFolder: invoke('dialog:openFolder'),
    pickFile: invoke('dialog:openFile')
  },
  file: {
    read: invoke('file:read'),
    write: invoke('file:write'),
    create: invoke('file:create'),
    mkdir: invoke('file:mkdir'),
    exists: invoke('file:exists'),
    rename: invoke('file:rename'),
    trash: invoke('file:trash'),
    reveal: invoke('file:reveal'),
    saveDialog: invoke('dialog:saveFile'),
    writeBase64: invoke('file:writeBase64'),
    readBase64: invoke('file:readBase64'),
    append: invoke('file:append'),
    stat: invoke('file:stat'),
    list: invoke('file:list'),
    openPath: invoke('file:openPath'),
    historyList: invoke('history:list'),
    historyRead: invoke('history:read'),
    hotSave: invoke('hot:save'),
    hotLoad: invoke('hot:load'),
    hotClear: invoke('hot:clear'),
    zipList: invoke('zip:list'),
    zipWrite: invoke('zip:write')
  },
  toolchain: {
    ensure: invoke('toolchain:ensure'),
    boards: invoke('boards:list'),
    knownBoards: invoke('boards:all'),
    cores: invoke('cores:installed'),
    coreInstall: invoke('cores:install'),
    coreUninstall: invoke('cores:uninstall'),
    libSearch: invoke('libs:search'),
    libInstall: invoke('libs:install'),
    libUninstall: invoke('libs:uninstall'),
    libInstalled: invoke('libs:installed'),
    libUpdatable: invoke('libs:updatable'),
    libUpgradeAll: invoke('libs:upgradeAll'),
    libInstallZip: invoke('libs:installZip'),
    coreUpgradeAll: invoke('cores:upgradeAll'),
    compile: invoke('build:compile'),
    upload: invoke('build:upload'),
    uploadProgrammer: invoke('build:uploadProgrammer'),
    burnBootloader: invoke('build:burnBootloader'),
    boardDetails: invoke('boards:details'),
    version: invoke('toolchain:version'),
    libExamples: invoke('libs:examples'),
    libVersions: invoke('libs:versions'),
    libInstallVersion: invoke('libs:installVersion'),
    applyBoardUrls: invoke('boards:applyUrls'),
    cancel: invoke('build:cancel')
  },
  serial: {
    ports: invoke('serial:ports'),
    open: invoke('serial:open'),
    close: invoke('serial:close'),
    writeLine: invoke('serial:writeLine'),
    setBaud: invoke('serial:setBaud'),
    reset: invoke('serial:reset'),
    writeRaw: invoke('serial:writeRaw'),
    signals: invoke('serial:signals')
  },
  devices: { list: invoke('devices:list') },
  catalog: {
    stats: invoke('catalog:stats'),
    cats: invoke('catalog:cats'),
    search: invoke('catalog:search'),
    get: invoke('catalog:get'),
    refresh: invoke('catalog:refresh')
  },
  pi: {
    connect: invoke('pi:connect'),
    disconnect: invoke('pi:disconnect'),
    gpioWrite: invoke('pi:gpioWrite'),
    setMode: invoke('pi:setMode')
  },
  ai: { chat: invoke('ai:chat'), abort: invoke('ai:abort') },
  upy: {
    run: invoke('upy:run'), upload: invoke('upy:upload'), ls: invoke('upy:ls'), read: invoke('upy:read'),
    rm: invoke('upy:rm'), info: invoke('upy:info'), interrupt: invoke('upy:interrupt'),
    softReset: invoke('upy:softReset'), drives: invoke('cpy:drives'), copyToDrive: invoke('cpy:copy'),
    readB64: invoke('upy:readB64'), setClock: invoke('upy:setClock'),
    mkdir: invoke('upy:mkdir'), syntax: invoke('upy:syntax'), copyDir: invoke('cpy:copyDir')
  },
  git: {
    status: invoke('git:status'), init: invoke('git:init'), diff: invoke('git:diff'), show: invoke('git:show'),
    stage: invoke('git:stage'), unstage: invoke('git:unstage'), commit: invoke('git:commit'),
    log: invoke('git:log'), identity: invoke('git:identity'), setIdentity: invoke('git:setIdentity'),
    discard: invoke('git:discard'), branches: invoke('git:branches'), createBranch: invoke('git:createBranch'),
    switchBranch: invoke('git:switchBranch'),
    remotes: invoke('git:remotes'), setRemote: invoke('git:setRemote'), push: invoke('git:push'),
    pull: invoke('git:pull'), fetch: invoke('git:fetch'), commitDetails: invoke('git:commitDetails'),
    blame: invoke('git:blame')
  },
  openExternal: invoke('shell:openExternal'),
  on(channel, fn) {
    if (!EVENTS.includes(channel)) throw new Error('unknown channel ' + channel);
    const wrapped = (e, payload) => fn(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
});
