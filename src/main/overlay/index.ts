import fs from 'fs'
import net from 'net'
import path from 'path'
import crypto from 'crypto'
import { readZipFiles, walkZip } from '../util/zip'
import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import type { Instance, OverlayConfig } from '@shared/types'
import { dirs, getSettings, updateSettings } from '../settings'
import { gameDir } from '../instances'
import { downloadFile } from '../util/net'
import { exists, ensureDir } from '../util/store'
import { clientJarPath } from '../minecraft/install'
import type { ResolvedVersion } from '../minecraft/versions'
import { buildOverlayMappings } from './mappings'
import { emit } from '../events'

/*
 * Оверлей-помощник: Java-агент присылает состояние игры по локальному сокету,
 * а лаунчер рисует прозрачное окно поверх окна Minecraft. Это не мод —
 * работает на ванилле и любом загрузчике, ничего не кладёт в папку mods.
 */

export const DEFAULT_OVERLAY: OverlayConfig = {
  loot: true,
  worldIcons: true,
  radius: 24,
  arrows: true,
  coords: false,
  fps: false,
  clock: false,
  armor: true,
  offhand: true,
  rightSide: false,
  maxLines: 8,
  borderless: true
}

interface Session {
  token: string
  missing?: string[]
  snapshots?: number
  instance: Instance
  rootId: string
  socket?: net.Socket
  win?: BrowserWindow
  last?: Snapshot
  bounds?: string
  borderless?: string
  /** время отправки снимка, который оверлей ещё не отрисовал */
  inFlight?: number
  /** свежий снимок, ждущий отправки */
  queued?: string
}

interface Snapshot {
  t: string
  win?: number[]
  active?: boolean
  screen?: boolean
  hideGui?: boolean
  inGame?: boolean
  /** состояние «полного экрана без рамки» от агента */
  bl?: string
}

let server: net.Server | null = null
let port = 0
const sessions = new Map<string, Session>()
let menuOpen = false
let menuIndex = 0

export function overlayConfig(): OverlayConfig {
  return { ...DEFAULT_OVERLAY, ...(getSettings().overlay || {}) }
}

function bundledAgent(): string {
  return app.isPackaged ? path.join(process.resourcesPath, 'helper', 'aurora-overlay.jar') : path.join(app.getAppPath(), 'resources', 'helper', 'aurora-overlay.jar')
}

async function agentJar(): Promise<string | null> {
  if (exists(bundledAgent())) return bundledAgent()
  const cached = path.join(ensureDir(path.join(dirs.cache(), 'overlay')), `aurora-overlay-${app.getVersion()}.jar`)
  if (exists(cached)) return cached
  try {
    await downloadFile({ url: 'https://github.com/KIRILLTAN/aurora-launcher/releases/latest/download/aurora-overlay.jar', path: cached })
    return cached
  } catch {
    return null
  }
}

/** Путь без не-ASCII символов: при необходимости копируем файл в C:\ProgramData (или другую ASCII-папку). */
export function asciiPath(file: string): string {
  if (/^[ -~]*$/.test(file)) return file
  const roots = [process.env['ProgramData'], process.env['PUBLIC'], process.env['SystemDrive'] ? process.env['SystemDrive'] + '\\' : undefined, app.getPath('temp')]
  for (const root of roots) {
    if (!root || !/^[ -~]*$/.test(root)) continue
    try {
      const dir = ensureDir(path.join(root, 'AuroraLauncher'))
      const dst = path.join(dir, path.basename(file))
      const src = fs.statSync(file)
      if (!exists(dst) || fs.statSync(dst).size !== src.size) fs.copyFileSync(file, dst)
      return dst
    } catch {
      /* нет прав — пробуем следующую папку */
    }
  }
  return file
}

function ensureServer(): Promise<void> {
  if (server) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server = net.createServer(onConnection)
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      port = (server!.address() as net.AddressInfo).port
      resolve()
    })
  })
}

/** Аргумент -javaagent для запуска игры или null, если помощник выключен/не поддерживается. */
export async function prepareOverlay(inst: Instance, v: ResolvedVersion): Promise<{ arg: string | null; reason?: string }> {
  if (!getSettings().helperEnabled) return { arg: null, reason: 'выключен — включите «Настройки → Кастомный помощник в игре»' }
  const jar = await agentJar()
  if (!jar) return { arg: null, reason: 'не удалось скачать агент оверлея' }
  const map = await buildOverlayMappings(inst, v).catch(() => null)
  if (!map) return { arg: null, reason: `версия ${inst.mcVersion} (${inst.loader}) пока не поддерживается оверлеем` }
  await ensureServer()
  const token = crypto.randomBytes(12).toString('hex')
  sessions.set(token, { token, instance: inst, rootId: v.rootId })
  const flags = overlayConfig().borderless ? 'b' : ''
  // Java на Windows портит не-ASCII символы в аргументах агента («D:\Новая папка» → «D:\????? ?????»),
  // поэтому путь к маппингам передаём в base64, а сам jar — только по ASCII-пути
  const mapArg = 'b64:' + Buffer.from(map.file, 'utf8').toString('base64url')
  return { arg: `-javaagent:${asciiPath(jar)}=${port}|${token}|${mapArg}|${flags}` }
}

function onConnection(socket: net.Socket): void {
  socket.setNoDelay(true)
  let buf = ''
  let session: Session | null = null
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop() || ''
    // если снимки накопились, старые не нужны: берём только самый свежий, иначе оверлей отстаёт на секунды
    let latest: string | null = null
    for (const line of lines) {
      if (!line) continue
      if (session) {
        latest = line
        continue
      }
      if (!session) {
        try {
          const hello = JSON.parse(line) as { t: string; token: string; missing: string[]; error?: string }
          session = sessions.get(hello.token) || null
          if (!session) return socket.destroy()
          session.socket = socket
          session.missing = hello.missing
          session.snapshots = 0
          if (hello.missing.length) console.warn('[overlay] не найдено:', hello.missing.join(', '))
          emit('game:log', [
            {
              instanceId: session.instance.id,
              line: hello.missing.length
                ? `[Aurora] Помощник F6 подключён, но не нашёл в игре: ${hello.missing.join(', ')}`
                : '[Aurora] Помощник F6 подключён — нажмите F6 в игре',
              level: hello.missing.length ? 'warn' : 'info'
            },
            ...(hello.error ? [{ instanceId: session.instance.id, line: `[Aurora] Помощник: ${hello.error}`, level: 'warn' as const }] : [])
          ])
          openWindow(session)
          registerKeys()
        } catch {
          socket.destroy()
        }
        continue
      }
    }
    if (session && latest) onSnapshot(session, latest)
  })
  const close = (): void => {
    if (!session) return
    session.win?.destroy()
    sessions.delete(session.token)
    session = null
    if (![...sessions.values()].some((s) => s.socket)) {
      menuOpen = false
      globalShortcut.unregisterAll()
    }
  }
  socket.on('close', close)
  socket.on('error', close)
}

function openWindow(s: Session): void {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'] + '/overlay.html')
  else win.loadFile(path.join(__dirname, '../renderer/overlay.html'))
  win.webContents.once('did-finish-load', () => pushConfig())
  s.win = win
}

function onSnapshot(s: Session, line: string): void {
  const win = s.win
  if (!win || win.isDestroyed()) return
  let snap: Snapshot
  try {
    snap = JSON.parse(line) as Snapshot
  } catch {
    return
  }
  s.last = snap
  s.snapshots = (s.snapshots || 0) + 1
  if (snap.bl && snap.bl !== s.borderless) {
    s.borderless = snap.bl
    emit('game:log', [{ instanceId: s.instance.id, line: `[Aurora] Полный экран для помощника: ${snap.bl}`, level: 'info' }])
  }
  if (snap.win && snap.win.length >= 4 && snap.win[2] > 0) {
    const [x, y, w, h] = snap.win
    let rect = { x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) }
    if (process.platform === 'win32') rect = screen.screenToDipRect(null, rect)
    const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
    if (key !== s.bounds) {
      s.bounds = key
      win.setBounds(rect)
    }
  }
  const visible = menuOpen || (snap.active !== false && snap.inGame === true)
  if (visible && !win.isVisible()) win.showInactive()
  else if (!visible && win.isVisible()) win.hide()
  if (visible) deliver(s, line)
}

/**
 * В окно оверлея — только свежий снимок и не больше одного «в пути»: следующий уходит,
 * когда оверлей отрисовал предыдущий. Так не копится очередь и картинка не отстаёт от игры.
 */
function deliver(s: Session, line: string): void {
  const win = s.win
  if (!win || win.isDestroyed()) return
  if (s.inFlight && Date.now() - s.inFlight < 250) {
    s.queued = line
    return
  }
  s.queued = undefined
  s.inFlight = Date.now()
  win.webContents.send('overlay:data', line)
}

ipcMain.on('overlay:ack', (e) => {
  for (const s of sessions.values()) {
    if (!s.win || s.win.isDestroyed() || s.win.webContents !== e.sender) continue
    s.inFlight = 0
    if (s.queued) deliver(s, s.queued)
  }
})

// ---------------- Меню и клавиши ----------------

const MENU: { key: keyof OverlayConfig; label: string; values?: number[] }[] = [
  { key: 'loot', label: 'Лут списком' },
  { key: 'worldIcons', label: 'Иконки над лутом (сквозь блоки)' },
  { key: 'radius', label: 'Радиус поиска', values: [8, 16, 24, 32, 48, 64] },
  { key: 'arrows', label: 'Стрелки-направления' },
  { key: 'maxLines', label: 'Строк в списке', values: [4, 6, 8, 12, 16] },
  { key: 'armor', label: 'HUD брони (справа)' },
  { key: 'offhand', label: 'HUD щита / левой руки' },
  { key: 'coords', label: 'Координаты' },
  { key: 'fps', label: 'FPS' },
  { key: 'clock', label: 'Часы' },
  { key: 'rightSide', label: 'Панель справа' }
]

function pushConfig(): void {
  const payload = { config: overlayConfig(), menu: menuOpen ? { index: menuIndex, items: MENU.map((m) => ({ key: m.key, label: m.label })) } : null }
  for (const s of sessions.values()) if (s.win && !s.win.isDestroyed()) s.win.webContents.send('overlay:config', payload)
}

function change(dir: number): void {
  const item = MENU[menuIndex]
  const cfg = overlayConfig()
  const cur = cfg[item.key]
  let next: number | boolean
  if (item.values) {
    const i = item.values.indexOf(cur as number)
    next = item.values[(i + dir + item.values.length) % item.values.length]
  } else next = !cur
  updateSettings({ overlay: { ...cfg, [item.key]: next } })
  pushConfig()
}

function setMenu(open: boolean): void {
  menuOpen = open
  const keys = ['Up', 'Down', 'Left', 'Right', 'Enter', 'Escape']
  if (open) {
    globalShortcut.register('Up', () => ((menuIndex = (menuIndex + MENU.length - 1) % MENU.length), pushConfig()))
    globalShortcut.register('Down', () => ((menuIndex = (menuIndex + 1) % MENU.length), pushConfig()))
    globalShortcut.register('Left', () => change(-1))
    globalShortcut.register('Right', () => change(1))
    globalShortcut.register('Enter', () => change(1))
    globalShortcut.register('Escape', () => setMenu(false))
  } else {
    for (const k of keys) if (globalShortcut.isRegistered(k)) globalShortcut.unregister(k)
  }
  for (const s of sessions.values()) {
    if (!s.win || s.win.isDestroyed()) continue
    if (open && !s.win.isVisible()) s.win.showInactive()
  }
  pushConfig()
}

function registerKeys(): void {
  if (globalShortcut.isRegistered('F6')) return
  globalShortcut.register('F6', () => setMenu(!menuOpen))
}

/** Переключение пункта меню кликом мыши (когда курсор игры свободен). */
export function overlayToggle(key: keyof OverlayConfig): void {
  const i = MENU.findIndex((m) => m.key === key)
  if (i >= 0) {
    menuIndex = i
    change(1)
  }
}

// ---------------- Иконки предметов ----------------

const iconCache = new Map<string, Promise<string>>()
/** Индекс текстур: путь внутри jar → jar. Строится один раз за сессию только по оглавлениям. */
const textureIndex = new WeakMap<Session, Promise<Map<string, string>>>()

function texturesOf(session: Session): Promise<Map<string, string>> {
  let idx = textureIndex.get(session)
  if (!idx) {
    idx = (async () => {
      const map = new Map<string, string>()
      const jars = [clientJarPath(session.instance.versionId || session.rootId), clientJarPath(session.rootId)]
      const mods = path.join(gameDir(session.instance.id), 'mods')
      if (exists(mods)) for (const f of await fs.promises.readdir(mods)) if (f.endsWith('.jar')) jars.push(path.join(mods, f))
      for (const jar of jars) {
        if (!exists(jar)) continue
        await walkZip(jar, (e) => {
          const n = e.fileName
          if (n.startsWith('assets/') && n.endsWith('.png') && n.includes('/textures/') && !map.has(n)) map.set(n, jar)
        }).catch(() => undefined)
      }
      return map
    })()
    textureIndex.set(session, idx)
  }
  return idx
}

/** Текстура предмета по его descriptionId: из jar игры или модов сборки. */
export function overlayIcon(descriptionId: string): Promise<string> {
  const session = [...sessions.values()].find((s) => s.socket)
  if (!session) return Promise.resolve('')
  const key = session.instance.id + '|' + descriptionId
  let p = iconCache.get(key)
  if (!p) {
    p = findIcon(session, descriptionId).catch(() => '')
    iconCache.set(key, p)
  }
  return p
}

async function findIcon(session: Session, descriptionId: string): Promise<string> {
  // форматы: "item.minecraft.diamond", "block.minecraft.stone" или "minecraft:diamond"
  const colon = /^([a-z0-9_.-]+):([a-z0-9_/.-]+)$/.exec(descriptionId)
  const m = colon ? ['', 'item', colon[1], colon[2]] : /^(item|block)\.([^.]+)\.(.+)$/.exec(descriptionId)
  if (!m) return ''
  const [, kind, ns, rawPath] = m
  const p = rawPath.replace(/\./g, '/')
  const names = kind === 'item'
    ? [`item/${p}`, `block/${p}`, `items/${p}`]
    : [`block/${p}`, `item/${p}`, `block/${p}_top`, `block/${p}_side`, `block/${p}_front`, `blocks/${p}`, `block/${p.replace(/_(slab|stairs|wall|fence|fence_gate|button|pressure_plate)$/, '')}`, `block/${p.replace(/_(slab|stairs|wall)$/, 's')}`]
  const index = await texturesOf(session)
  for (const n of names) {
    const entry = `assets/${ns}/textures/${n}.png`
    const jar = index.get(entry)
    if (!jar) continue
    const buf = (await readZipFiles(jar, [entry])).get(entry)
    if (buf) return 'data:image/png;base64,' + buf.toString('base64')
  }
  return ''
}

/** Диагностика для самопроверки. */
export function overlayDiagnostics(): { instance: string; connected: boolean; missing?: string[]; snapshots: number; last?: unknown; visible?: boolean; bounds?: Electron.Rectangle }[] {
  return [...sessions.values()].map((s) => ({
    instance: s.instance.id,
    connected: !!s.socket,
    missing: s.missing,
    snapshots: s.snapshots || 0,
    last: s.last,
    visible: s.win && !s.win.isDestroyed() ? s.win.isVisible() : undefined,
    bounds: s.win && !s.win.isDestroyed() ? s.win.getBounds() : undefined
  }))
}

export function shutdownOverlay(): void {
  globalShortcut.unregisterAll()
  for (const s of sessions.values()) s.win?.destroy()
}
