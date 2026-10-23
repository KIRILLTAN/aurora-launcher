import fs from 'fs'
import path from 'path'
import net from 'net'
import dns from 'dns'
import AdmZip from 'adm-zip'
import { nativeImage } from 'electron'
import type { ServerStatus, ModUpdate, WorldInfo, ScreenshotInfo } from '@shared/types'
import { gameDir, getInstance, instanceDir } from './instances'
import { fetchJson, downloadFile, sha1File } from './util/net'
import { exists, ensureDir, safeJoin } from './util/store'
import { withTask, withCancellableTask } from './events'
import { modsDir } from './mods'
import { HELPER_FILE } from './helper'
import { installModrinthProject } from './catalog/modpacks'

// ---------------- Пинг серверов (Server List Ping) ----------------

function varint(n: number): Buffer {
  const out: number[] = []
  let v = n >>> 0
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v) b |= 0x80
    out.push(b)
  } while (v)
  return Buffer.from(out)
}

function readVarint(buf: Buffer, off: number): [number, number] | null {
  let n = 0
  let shift = 0
  for (let i = off; i < buf.length; i++) {
    n |= (buf[i] & 0x7f) << shift
    if (!(buf[i] & 0x80)) return [n, i + 1]
    shift += 7
    if (shift > 35) throw new Error('bad varint')
  }
  return null
}

function packet(id: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat([varint(id), ...parts])
  return Buffer.concat([varint(body.length), body])
}

function chatText(c: unknown): string {
  if (typeof c === 'string') return c
  if (!c || typeof c !== 'object') return ''
  const o = c as { text?: string; extra?: unknown[]; translate?: string }
  return (o.text || o.translate || '') + (o.extra || []).map(chatText).join('')
}

async function resolveAddress(address: string): Promise<{ host: string; port: number }> {
  const m = /^\[?([^\]]+?)\]?(?::(\d+))?$/.exec(address.trim())
  const host = m?.[1] || address
  if (m?.[2]) return { host, port: parseInt(m[2]) }
  try {
    const srv = await dns.promises.resolveSrv(`_minecraft._tcp.${host}`)
    if (srv[0]) return { host: srv[0].name, port: srv[0].port }
  } catch {
    /* нет SRV-записи */
  }
  return { host, port: 25565 }
}

export async function pingServer(address: string): Promise<ServerStatus> {
  const { host, port } = await resolveAddress(address)
  return new Promise((resolve) => {
    const started = Date.now()
    const sock = net.connect({ host, port, timeout: 6000 })
    let buf = Buffer.alloc(0)
    const done = (s: ServerStatus): void => {
      sock.destroy()
      resolve(s)
    }
    sock.on('connect', () => {
      const hostBuf = Buffer.from(host, 'utf8')
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(port)
      sock.write(packet(0, varint(767), varint(hostBuf.length), hostBuf, portBuf, varint(1)))
      sock.write(packet(0))
    })
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      const len = readVarint(buf, 0)
      if (!len || buf.length < len[1] + len[0]) return
      try {
        const id = readVarint(buf, len[1])!
        const strLen = readVarint(buf, id[1])!
        const json = JSON.parse(buf.subarray(strLen[1], strLen[1] + strLen[0]).toString('utf8'))
        done({
          online: true,
          latency: Date.now() - started,
          players: json.players?.online ?? 0,
          maxPlayers: json.players?.max ?? 0,
          version: json.version?.name,
          motd: chatText(json.description).replace(/§./g, '').trim(),
          favicon: typeof json.favicon === 'string' ? json.favicon : undefined
        })
      } catch {
        done({ online: false, error: 'Непонятный ответ сервера' })
      }
    })
    sock.on('timeout', () => done({ online: false, error: 'Сервер не отвечает' }))
    sock.on('error', (e) => done({ online: false, error: e.message }))
  })
}

// ---------------- Ускорение FPS в один клик ----------------

const FPS_MODS: Record<string, string[]> = {
  fabric: ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix'],
  quilt: ['sodium', 'lithium', 'ferrite-core', 'entityculling', 'immediatelyfast', 'modernfix'],
  neoforge: ['sodium', 'ferrite-core', 'entityculling', 'modernfix', 'immediatelyfast'],
  forge: ['embeddium', 'ferrite-core', 'entityculling', 'modernfix', 'immediatelyfast']
}

export function boostFps(instanceId: string): Promise<{ installed: string[]; skipped: string[] }> {
  const inst = getInstance(instanceId)
  const list = FPS_MODS[inst.loader]
  if (!list) throw new Error('Для ванильной сборки сначала выберите загрузчик (Fabric/Forge/NeoForge)')
  return withCancellableTask('Ускорение FPS', async (t) => {
    const present = fs.readdirSync(modsDir(instanceId)).join(' ').toLowerCase()
    if (present.includes('optifine')) throw new Error('В сборке есть OptiFine — он несовместим с Sodium/Embeddium. Удалите его и повторите.')
    const installed: string[] = []
    const skipped: string[] = []
    for (let i = 0; i < list.length; i++) {
      const slug = list[i]
      t.update(i / list.length, slug)
      if (present.includes(slug.replace('-', ''))) {
        skipped.push(`${slug} (уже есть)`)
        continue
      }
      try {
        installed.push(...(await installModrinthProject(instanceId, slug, 'mod')))
      } catch {
        skipped.push(`${slug} (нет для ${inst.mcVersion})`)
      }
    }
    return { installed, skipped }
  })
}

// ---------------- Шейдеры: Iris/Oculus подбираются под загрузчик ----------------

interface ShaderPlan {
  supported: boolean
  installed?: string
  mods: string[]
  loader?: string
  reason?: string
}

function shaderPlan(instanceId: string): ShaderPlan {
  const inst = getInstance(instanceId)
  const present = exists(path.join(gameDir(instanceId), 'mods')) ? fs.readdirSync(path.join(gameDir(instanceId), 'mods')).join(' ').toLowerCase() : ''
  if (present.includes('optifine')) return { supported: true, installed: 'OptiFine', mods: [] }
  for (const n of ['iris', 'oculus']) if (present.includes(n)) return { supported: true, installed: n === 'iris' ? 'Iris' : 'Oculus', mods: [] }
  const modern = /^\d{2}\./.test(inst.mcVersion)
  switch (inst.loader) {
    case 'fabric':
    case 'quilt':
      return { supported: true, mods: ['iris', 'sodium'] }
    case 'neoforge':
      return inst.mcVersion === '1.20.1' ? { supported: true, mods: ['oculus', 'embeddium'], loader: 'forge' } : { supported: true, mods: ['iris', 'sodium'] }
    case 'forge':
      return modern || inst.mcVersion.startsWith('1.21')
        ? { supported: false, mods: [], reason: 'Для Forge этой версии нет Iris/Oculus — используйте NeoForge или Fabric' }
        : { supported: true, mods: ['oculus', 'embeddium'] }
    default:
      return { supported: false, mods: [], reason: 'Шейдерам нужен загрузчик модов — создайте сборку Fabric (ванилла шейдеры не поддерживает)' }
  }
}

export function shaderStatus(instanceId: string): { supported: boolean; installed?: string; reason?: string } {
  const p = shaderPlan(instanceId)
  return { supported: p.supported, installed: p.installed, reason: p.reason }
}

/** Ставит всё, что нужно для шейдеров (Iris+Sodium или Oculus+Embeddium). */
export async function ensureShaderSupport(instanceId: string): Promise<string[]> {
  const p = shaderPlan(instanceId)
  if (p.installed) return []
  if (!p.supported) throw new Error(p.reason)
  const out: string[] = []
  for (const slug of p.mods) out.push(...(await installModrinthProject(instanceId, slug, 'mod', undefined, p.loader)))
  return out
}

// ---------------- Обновления модов ----------------

interface MrVersionLite {
  id: string
  version_number: string
  files: { url: string; filename: string; primary: boolean; hashes: { sha1: string } }[]
}

export async function checkModUpdates(instanceId: string): Promise<ModUpdate[]> {
  const inst = getInstance(instanceId)
  const dir = modsDir(instanceId)
  const files = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f) && f !== HELPER_FILE)
  const hashes = new Map<string, string>()
  for (const f of files) hashes.set(await sha1File(path.join(dir, f)), f)
  if (!hashes.size) return []
  const loaders = inst.loader === 'quilt' ? ['quilt', 'fabric'] : [inst.loader]
  const res = await fetchJson<Record<string, MrVersionLite>>('https://api.modrinth.com/v2/version_files/update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: [...hashes.keys()], algorithm: 'sha1', loaders, game_versions: [inst.mcVersion] })
  })
  const out: ModUpdate[] = []
  for (const [hash, v] of Object.entries(res)) {
    const file = v.files.find((f) => f.primary) || v.files[0]
    if (!file || file.hashes.sha1 === hash) continue
    out.push({ file: hashes.get(hash)!, newFile: file.filename, version: v.version_number, url: file.url, sha1: file.hashes.sha1 })
  }
  return out
}

export function applyModUpdates(instanceId: string, updates: ModUpdate[]): Promise<number> {
  return withCancellableTask('Обновление модов', async (t) => {
    const dir = modsDir(instanceId)
    for (let i = 0; i < updates.length; i++) {
      const u = updates[i]
      t.update(i / updates.length, u.newFile)
      await downloadFile({ url: u.url, path: safeJoin(dir, u.newFile), sha1: u.sha1 }, undefined, 3, t.signal)
      if (u.file !== u.newFile) fs.rmSync(path.join(dir, path.basename(u.file)), { force: true })
    }
    return updates.length
  })
}

// ---------------- Миры и скриншоты ----------------

function dirSize(p: string): number {
  let total = 0
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name)
    total += e.isDirectory() ? dirSize(f) : fs.statSync(f).size
  }
  return total
}

export function listWorlds(instanceId: string): WorldInfo[] {
  const saves = path.join(gameDir(instanceId), 'saves')
  if (!exists(saves)) return []
  return fs
    .readdirSync(saves, { withFileTypes: true })
    .filter((e) => e.isDirectory() && exists(path.join(saves, e.name, 'level.dat')))
    .map((e) => {
      const p = path.join(saves, e.name)
      const icon = path.join(p, 'icon.png')
      return {
        folder: e.name,
        lastPlayed: fs.statSync(path.join(p, 'level.dat')).mtimeMs,
        size: dirSize(p),
        icon: exists(icon) ? 'data:image/png;base64,' + fs.readFileSync(icon).toString('base64') : undefined
      }
    })
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
}

export function backupWorld(instanceId: string, folder: string): Promise<string> {
  return withTask(`Бэкап мира «${folder}»`, async () => {
    const src = safeJoin(path.join(gameDir(instanceId), 'saves'), folder)
    const outDir = ensureDir(path.join(instanceDir(instanceId), 'backups'))
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')
    const target = path.join(outDir, `${folder}-${stamp}.zip`)
    const zip = new AdmZip()
    zip.addLocalFolder(src, folder)
    await zip.writeZipPromise(target)
    return target
  })
}

export function listScreenshots(instanceId: string, limit = 40): ScreenshotInfo[] {
  const dir = path.join(gameDir(instanceId), 'screenshots')
  if (!exists(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .slice(0, limit)
    .map(({ f, t }) => {
      const p = path.join(dir, f)
      const img = nativeImage.createFromPath(p)
      return { file: f, path: p, time: t, thumb: img.isEmpty() ? '' : img.resize({ width: 640 }).toDataURL() }
    })
}
