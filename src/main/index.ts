import { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import type { Instance, Settings, CrashAnalysis, LoaderType, ModUpdate } from '@shared/types'
import { getSettings, updateSettings, publicSettings, dirs } from './settings'
import * as instances from './instances'
import * as accounts from './auth/accounts'
import * as java from './java/java'
import * as mods from './mods'
import * as skins from './skins'
import * as modrinth from './catalog/modrinth'
import * as curseforge from './catalog/curseforge'
import * as packs from './catalog/modpacks'
import { listVersions } from './minecraft/versions'
import { listLoaderVersions } from './minecraft/loaders'
import { launchInstance, stopInstance, runningIds, getLog, reinstallInstance } from './minecraft/launch'
import { askAi } from './crash/ai'
import { getRemoteInfo, initUpdater, checkForUpdates, installUpdate, getUpdateStatus } from './remote'
import { withTask, emit } from './events'
import { runSelfTest } from './selftest'
import * as sync from './sync'
import * as features from './features'
import { helperSupported } from './helper'

let win: BrowserWindow | null = null

function createWindow(): void {
  nativeTheme.themeSource = 'dark'
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    show: false,
    backgroundColor: '#070a18',
    title: 'Aurora Launcher',
    icon: path.join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.on('ready-to-show', () => win?.show())
  win.on('maximize', () => emit('win:maximized', true))
  win.on('unmaximize', () => emit('win:maximized', false))
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(path.join(__dirname, '../renderer/index.html'))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => unknown
const handlers: Record<string, Handler> = {
  // окно и система
  'app:info': () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch, dataDir: getSettings().dataDir, totalMem: Math.round(os.totalmem() / 1048576) }),
  'win:minimize': () => win?.minimize(),
  'win:maximize': () => (win?.isMaximized() ? win.unmaximize() : win?.maximize()),
  'win:close': () => win?.close(),
  'shell:openPath': (p: string) => shell.openPath(p),
  'shell:openUrl': (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
  },
  'dialog:openFile': async (filters: Electron.FileFilter[], multi = false) => {
    const r = await dialog.showOpenDialog(win!, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters })
    return r.canceled ? [] : r.filePaths
  },
  'dialog:openDir': async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  },
  'dialog:saveFile': async (name: string, filters: Electron.FileFilter[]) => {
    const r = await dialog.showSaveDialog(win!, { defaultPath: name, filters })
    return r.canceled ? null : r.filePath
  },

  // настройки
  'settings:get': () => publicSettings(),
  'settings:update': (patch: Partial<Settings>) => {
    const p = { ...patch }
    if (p.anthropicKey?.startsWith('••••')) delete p.anthropicKey
    if (p.curseforgeKey?.startsWith('••••')) delete p.curseforgeKey
    updateSettings(p)
    return publicSettings()
  },

  // версии
  'versions:list': () => listVersions(),
  'loaders:list': (loader: LoaderType, mc: string) => listLoaderVersions(loader, mc),

  // сборки
  'instances:list': () => instances.listInstances(),
  'instances:get': (id: string) => instances.getInstance(id),
  'instances:create': (data: Omit<Instance, 'id' | 'createdAt'>) => {
    const inst = instances.createInstance(data)
    updateSettings({ selectedInstance: inst.id })
    return inst
  },
  'instances:update': (id: string, patch: Partial<Instance>) => instances.updateInstance(id, patch),
  'instances:delete': (id: string) => instances.deleteInstance(id),
  'instances:duplicate': (id: string) => instances.duplicateInstance(id),
  'instances:openFolder': (id: string, sub?: string) => {
    const dir = path.join(instances.gameDir(id), sub || '')
    fs.mkdirSync(dir, { recursive: true })
    return shell.openPath(dir)
  },
  'instances:reinstall': (id: string) => reinstallInstance(id),
  'instances:export': async (id: string) => {
    const inst = instances.getInstance(id)
    const r = await dialog.showSaveDialog(win!, { defaultPath: `${inst.name}.mrpack`, filters: [{ name: 'Modrinth pack', extensions: ['mrpack'] }] })
    if (!r.canceled && r.filePath) await packs.exportInstance(id, r.filePath)
    return !r.canceled
  },

  // запуск игры
  'game:launch': async (id: string, accountId?: string, server?: string) => {
    updateSettings({ selectedInstance: id })
    await launchInstance(id, accountId || getSettings().selectedAccount, server)
    const after = getSettings().afterLaunch
    if (after === 'hide') win?.hide()
    else if (after === 'close') setTimeout(() => app.quit(), 3000)
  },
  'game:stop': (id: string) => stopInstance(id),
  'game:running': () => runningIds(),
  'game:log': (id: string) => getLog(id),
  'crash:ai': (instanceId: string, analysis: CrashAnalysis, javaInfo: string) => askAi(instances.getInstance(instanceId), analysis, javaInfo),

  // моды
  'mods:list': (id: string) => mods.listMods(id),
  'mods:toggle': (id: string, file: string, enabled: boolean) => mods.toggleMod(id, file, enabled),
  'mods:delete': (id: string, file: string) => mods.deleteMod(id, file),
  'mods:addFiles': (id: string, files: string[]) => {
    const dir = mods.modsDir(id)
    for (const f of files) if (/\.jar$/i.test(f)) fs.copyFileSync(f, path.join(dir, path.basename(f)))
  },

  // каталог
  'catalog:search': (source: 'modrinth' | 'curseforge', opts: Parameters<typeof modrinth.searchModrinth>[0]) =>
    source === 'modrinth' ? modrinth.searchModrinth(opts) : curseforge.searchCurseforge(opts),
  'catalog:versions': async (source: 'modrinth' | 'curseforge', projectId: string, mc?: string, loader?: string) =>
    source === 'modrinth'
      ? (await modrinth.modrinthVersions(projectId, mc, loader)).map(modrinth.toCatalogVersion)
      : curseforge.curseforgeFiles(projectId, mc, loader),
  'catalog:installPack': (source: 'modrinth' | 'curseforge', projectId: string, versionId?: string) =>
    source === 'modrinth' ? packs.installModrinthPack(projectId, versionId) : packs.installCurseforgePack(projectId, versionId),
  'catalog:installProject': (source: 'modrinth' | 'curseforge', instanceId: string, projectId: string, type: 'mod' | 'resourcepack' | 'shader', versionId?: string) =>
    source === 'modrinth'
      ? packs.installModrinthProject(instanceId, projectId, type, versionId)
      : packs.installCurseforgeProject(instanceId, projectId, type, versionId),
  'catalog:importFile': (file: string) => packs.importPackFile(file),
  'catalog:installUrl': (url: string, name?: string) => packs.installPackFromUrl(url, name),

  // аккаунты
  'accounts:list': () => accounts.listAccounts(),
  'accounts:addOffline': (name: string) => accounts.addOffline(name),
  'accounts:loginMicrosoft': () => accounts.loginMicrosoft(win || undefined),
  'accounts:loginYggdrasil': (server: string, user: string, pass: string, name?: string) => accounts.loginYggdrasil(server, user, pass, name),
  'accounts:remove': (id: string) => accounts.removeAccount(id),
  'accounts:select': (id: string) => updateSettings({ selectedAccount: id }),

  // java
  'java:list': () => java.cachedJavas(),
  'java:detect': () => java.detectJavas(),
  'java:add': (p: string) => java.addManualJava(p),
  'java:remove': (p: string) => java.removeJava(p),
  'java:releases': () => java.availableJavaReleases(),
  'java:install': (major: number, image: 'jre' | 'jdk') => withTask(`Установка Java ${major}`, (t) => java.installJava(major, t, image)),
  'java:required': (mc: string) => java.requiredJavaMajor(mc),
  'java:hint': (major: number) => java.javaHint(major),

  // скины
  'skins:fetch': (url: string) => skins.fetchImage(url),
  'skins:byName': (name: string, source: 'mojang' | 'ely') => skins.skinByName(name, source),
  'skins:list': () => skins.listSavedSkins(),
  'skins:save': (name: string, data: string, slim: boolean) => skins.saveSkin(name, data, slim),
  'skins:delete': (file: string) => skins.deleteSkin(file),
  'skins:uploadMs': (accountId: string, data: string, slim: boolean) => skins.uploadSkinMicrosoft(accountId, data, slim),
  'skins:openFolder': () => shell.openPath(dirs.skins()),

  // облачная синхронизация сборок
  'sync:status': () => sync.syncStatus(),
  'sync:githubStart': () => sync.startGithubLogin(),
  'sync:githubToken': (token: string) => sync.loginGithubToken(token),
  'sync:folder': async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Папка в облаке (Яндекс Диск, OneDrive, Google Drive…)', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? sync.syncStatus() : sync.useFolder(r.filePaths[0])
  },
  'sync:disconnect': () => sync.disconnect(),
  'sync:list': () => sync.listRemote(),
  'sync:push': (ids?: string[]) => sync.pushInstances(ids),
  'sync:pull': (id: string) => sync.pullInstance(id),
  'sync:remove': (id: string) => sync.removeRemote(id),

  // дополнительные возможности
  'helper:supported': (id: string) => helperSupported(instances.getInstance(id)),
  'servers:ping': (address: string) => features.pingServer(address),
  'features:boostFps': (id: string) => features.boostFps(id),
  'features:modUpdates': (id: string) => features.checkModUpdates(id),
  'features:applyUpdates': (id: string, updates: ModUpdate[]) => features.applyModUpdates(id, updates),
  'features:worlds': (id: string) => features.listWorlds(id),
  'features:backupWorld': (id: string, folder: string) => features.backupWorld(id, folder),
  'features:screenshots': (id: string) => features.listScreenshots(id),
  'shell:showItem': (p: string) => shell.showItemInFolder(p),

  // онлайн и обновления
  'remote:info': () => getRemoteInfo(),
  'update:status': () => getUpdateStatus(),
  'update:check': () => checkForUpdates(),
  'update:install': () => installUpdate()
}

for (const [channel, fn] of Object.entries(handlers)) {
  ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
    try {
      return { ok: true, data: await (fn as (...a: unknown[]) => unknown)(...args) }
    } catch (e) {
      console.error(`[ipc ${channel}]`, e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
}

// Показываем окно лаунчера обратно, когда игра закрылась
ipcMain.on('win:show', () => {
  win?.show()
  win?.focus()
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
  app.whenReady().then(() => {
    app.setAppUserModelId('com.kirilltan.aurora')
    dirs.root()
    createWindow()
    const selftest = process.env['AURORA_SELFTEST']
    if (selftest && win) {
      const w = win
      w.webContents.once('did-finish-load', () => void runSelfTest(w, selftest))
    }
    initUpdater()
    // первичный поиск Java в фоне
    java.detectJavas().catch(() => undefined)
  })
}

app.on('window-all-closed', () => {
  if (runningIds().length === 0) app.quit()
})
