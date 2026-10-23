import fs from 'fs'
import net from 'net'
import path from 'path'
import crypto from 'crypto'
import AdmZip from 'adm-zip'
import { app, BrowserWindow, globalShortcut, screen } from 'electron'
import type { Instance, OverlayConfig } from '@shared/types'
import { dirs, getSettings, updateSettings } from '../settings'
import { gameDir } from '../instances'
import { downloadFile } from '../util/net'
import { exists, ensureDir } from '../util/store'
import { clientJarPath } from '../minecraft/install'
import type { ResolvedVersion } from '../minecraft/versions'
import { buildOverlayMappings } from './mappings'

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
  maxLines: 8
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
}

interface Snapshot {
  t: string
  win?: number[]
  active?: boolean
  screen?: boolean
  hideGui?: boolean
  inGame?: boolean
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
  if (!getSettings().helperEnabled) return { arg: null }
  const jar = await agentJar()
  if (!jar) return { arg: null, reason: 'не удалось скачать агент оверлея' }
  const map = await buildOverlayMappings(inst, v).catch(() => null)
  if (!map) return { arg: null, reason: `версия ${inst.mcVersion} (${inst.loader}) пока не поддерживается оверлеем` }
  await ensureServer()
  const token = crypto.randomBytes(12).toString('hex')
  sessions.set(token, { token, instance: inst, rootId: v.rootId })
  return { arg: `-javaagent:${jar}=${port}|${token}|${map.file}` }
}

function onConnection(socket: net.Socket): void {
  socket.setNoDelay(true)
  let buf = ''
  let session: Session | null = null
  socket.setEncoding('utf8')
  socket.on('data', (chunk: string) => {
    buf += chunk
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!session) {
        try {
          const hello = JSON.parse(line) as { t: string; token: string; missing: string[] }
          session = sessions.get(hello.token) || null
          if (!session) return socket.destroy()
          session.socket = socket
          session.missing = hello.missing
          session.snapshots = 0
          if (hello.missing.length) console.warn('[overlay] не найдено:', hello.missing.join(', '))
          openWindow(session)
          registerKeys()
        } catch {
          socket.destroy()
        }
        continue
      }
      onSnapshot(session, line)
    }
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
  if (visible) win.webContents.send('overlay:data', line)
}

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

const zipCache = new Map<string, AdmZip | null>()
const iconCache = new Map<string, string>()

function zipOf(file: string): AdmZip | null {
  if (!zipCache.has(file)) {
    try {
      zipCache.set(file, new AdmZip(file))
    } catch {
      zipCache.set(file, null)
    }
  }
  return zipCache.get(file) || null
}

/** Текстура предмета по его descriptionId: из jar игры или модов сборки. */
export function overlayIcon(descriptionId: string): string {
  if (iconCache.has(descriptionId)) return iconCache.get(descriptionId)!
  // форматы: "item.minecraft.diamond", "block.minecraft.stone" или "minecraft:diamond"
  const colon = /^([a-z0-9_.-]+):([a-z0-9_/.-]+)$/.exec(descriptionId)
  const m = colon ? ['', 'item', colon[1], colon[2]] : /^(item|block)\.([^.]+)\.(.+)$/.exec(descriptionId)
  let result = ''
  const session = [...sessions.values()].find((s) => s.socket)
  if (m && session) {
    const [, kind, ns, rawPath] = m
    const p = rawPath.replace(/\./g, '/')
    const names = kind === 'item'
      ? [`item/${p}`, `block/${p}`, `items/${p}`]
      : [`block/${p}`, `item/${p}`, `block/${p}_top`, `block/${p}_side`, `block/${p}_front`, `blocks/${p}`, `block/${p.replace(/_(slab|stairs|wall|fence|fence_gate|button|pressure_plate)$/, '')}`, `block/${p.replace(/_(slab|stairs|wall)$/, 's')}`]
    const jars = [clientJarPath(session.instance.versionId || session.rootId), clientJarPath(session.rootId)]
    if (ns !== 'minecraft') {
      const mods = path.join(gameDir(session.instance.id), 'mods')
      if (exists(mods)) for (const f of fs.readdirSync(mods)) if (f.endsWith('.jar')) jars.push(path.join(mods, f))
    }
    outer: for (const jar of jars) {
      if (!exists(jar)) continue
      const zip = zipOf(jar)
      if (!zip) continue
      for (const n of names) {
        const e = zip.getEntry(`assets/${ns}/textures/${n}.png`)
        if (e) {
          result = 'data:image/png;base64,' + e.getData().toString('base64')
          break outer
        }
      }
    }
  }
  iconCache.set(descriptionId, result)
  return result
}

/** Диагностика для самопроверки. */
export function overlayDiagnostics(): { instance: string; connected: boolean; missing?: string[]; snapshots: number; last?: unknown }[] {
  return [...sessions.values()].map((s) => ({ instance: s.instance.id, connected: !!s.socket, missing: s.missing, snapshots: s.snapshots || 0, last: s.last }))
}

export function shutdownOverlay(): void {
  globalShortcut.unregisterAll()
  for (const s of sessions.values()) s.win?.destroy()
}
