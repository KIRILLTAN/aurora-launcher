import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { app, net, session } from 'electron'
import { CancelledError, isCancel, throwIfAborted } from './cancel'
import { getSettings } from '../settings'

export const USER_AGENT = `KIRILLTAN/aurora-launcher/${app.getVersion()} (github.com/KIRILLTAN/aurora-launcher)`

export interface DownloadItem {
  url: string
  path: string
  sha1?: string
  size?: number
  /** запасные зеркала */
  mirrors?: string[]
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

// ---------------- Зеркала (для России и других регионов с плохим доступом) ----------------

/*
 * MCIM (mod.mcimirror.top) — зеркало API Modrinth и CurseForge (CurseForge через него
 * работает даже без ключа), BMCLAPI (bmclapi2.bangbang93.com) — зеркало файлов Mojang,
 * Forge, NeoForge и Fabric. Режим «авто»: сначала прямой адрес, при ошибке или
 * таймауте — зеркало; хосты, которые не отвечали, дальше сразу идут через зеркало.
 */
const MIRRORS: [RegExp, string][] = [
  [/^https:\/\/api\.modrinth\.com\//, 'https://mod.mcimirror.top/modrinth/'],
  [/^https:\/\/cdn\.modrinth\.com\//, 'https://mod.mcimirror.top/'],
  [/^https:\/\/api\.curseforge\.com\//, 'https://mod.mcimirror.top/curseforge/'],
  [/^https:\/\/(?:edge|mediafilez)\.forgecdn\.net\//, 'https://mod.mcimirror.top/'],
  [/^https:\/\/(?:piston-meta|piston-data|launchermeta|launcher)\.mojang\.com\//, 'https://bmclapi2.bangbang93.com/'],
  [/^https:\/\/libraries\.minecraft\.net\//, 'https://bmclapi2.bangbang93.com/maven/'],
  [/^https?:\/\/resources\.download\.minecraft\.net\//, 'https://bmclapi2.bangbang93.com/assets/'],
  [/^https:\/\/maven\.minecraftforge\.net\//, 'https://bmclapi2.bangbang93.com/maven/'],
  [/^https:\/\/maven\.neoforged\.net\/releases\//, 'https://bmclapi2.bangbang93.com/maven/'],
  [/^https:\/\/meta\.fabricmc\.net\//, 'https://bmclapi2.bangbang93.com/fabric-meta/'],
  [/^https:\/\/maven\.fabricmc\.net\//, 'https://bmclapi2.bangbang93.com/maven/'],
  [/^https:\/\/authlib-injector\.yushi\.moe\//, 'https://bmclapi2.bangbang93.com/mirrors/authlib-injector/']
]

const badHosts = new Set<string>()

export function mirrorOf(url: string): string | null {
  for (const [re, to] of MIRRORS) if (re.test(url)) return url.replace(re, to)
  return null
}

/** Порядок адресов с учётом настройки зеркал и «плохих» хостов. */
export function candidates(url: string): string[] {
  const mode = getSettings().mirrors || 'auto'
  const mirror = mirrorOf(url)
  if (!mirror || mode === 'never') return [url]
  if (mode === 'always') return [mirror, url]
  let host = ''
  try {
    host = new URL(url).host
  } catch {
    /* ignore */
  }
  return badHosts.has(host) ? [mirror, url] : [url, mirror]
}

function markBad(url: string): void {
  try {
    badHosts.add(new URL(url).host)
  } catch {
    /* ignore */
  }
}

/** HTTP через сетевой стек Chromium: работают системный прокси, свой VPN/прокси и SOCKS5. */
export function httpFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return net.fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...(init.headers || {}) } } as RequestInit)
}

function withTimeout(signal: AbortSignal | null | undefined, ms: number): AbortSignal {
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

const retryable = (status: number): boolean => status === 403 || status === 429 || status === 451 || status >= 500

async function request(url: string, init: RequestInit, timeout: number): Promise<Response> {
  const list = candidates(url)
  let lastErr: unknown
  for (let i = 0; i < list.length; i++) {
    const u = list[i]
    const isMirror = u !== url
    const headers = { ...(init.headers as Record<string, string> | undefined) }
    // ключ CurseForge не отправляем на сторонние зеркала
    if (isMirror) delete headers['x-api-key']
    try {
      const res = await httpFetch(u, { ...init, headers, signal: withTimeout(init.signal, timeout) })
      if (res.ok || !retryable(res.status) || i === list.length - 1) return res
      lastErr = new HttpError(res.status, `HTTP ${res.status} ${u}`)
      if (!isMirror) markBad(url)
    } catch (e) {
      if (init.signal?.aborted) throw new CancelledError()
      lastErr = e
      if (!isMirror) markBad(url)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await request(url, { ...init, headers: { Accept: 'application/json', ...(init.headers || {}) } }, 15000)
  if (!res.ok) {
    let body = ''
    try {
      body = (await res.text()).slice(0, 300)
    } catch {
      /* ignore */
    }
    throw new HttpError(res.status, `HTTP ${res.status} ${url}${body ? ': ' + body : ''}`)
  }
  return (await res.json()) as T
}

export async function fetchText(url: string): Promise<string> {
  const res = await request(url, {}, 15000)
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} ${url}`)
  return res.text()
}

export function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1')
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', reject)
  })
}

async function isPresentAsync(item: DownloadItem): Promise<boolean> {
  try {
    const st = await fs.promises.stat(item.path)
    if (!st.isFile()) return false
    if (item.size && st.size !== item.size) return false
    return st.size > 0 || item.size === 0
  } catch {
    return false
  }
}

/** Файл уже скачан и выглядит целым (по размеру; sha1 проверяется при загрузке). */
export function isPresent(item: DownloadItem): boolean {
  try {
    const st = fs.statSync(item.path)
    if (!st.isFile()) return false
    if (item.size && st.size !== item.size) return false
    return st.size > 0 || item.size === 0
  } catch {
    return false
  }
}

export async function downloadFile(item: DownloadItem, onBytes?: (n: number) => void, attempts = 3, signal?: AbortSignal): Promise<void> {
  const base = [item.url, ...(item.mirrors || [])].filter(Boolean)
  const urls = [...new Set(base.flatMap((u) => candidates(u)))]
  const total = Math.max(attempts, urls.length + 1)
  let lastErr: unknown
  for (let i = 0; i < total; i++) {
    const url = urls[i % urls.length]
    throwIfAborted(signal)
    const tmp = item.path + '.part'
    let got = 0
    try {
      await fs.promises.mkdir(path.dirname(item.path), { recursive: true })
      const res = await httpFetch(url, { signal })
      if (!res.ok || !res.body) throw new HttpError(res.status, `HTTP ${res.status} ${url}`)
      const hash = crypto.createHash('sha1')
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk)
          got += chunk.length
          try {
            onBytes?.(chunk.length)
          } catch (e) {
            return cb(e as Error)
          }
          cb(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(tmp), { signal })
      const digest = hash.digest('hex')
      if (item.sha1 && digest !== item.sha1.toLowerCase()) {
        fs.rmSync(tmp, { force: true })
        throw new Error(`Контрольная сумма не совпала: ${path.basename(item.path)}`)
      }
      fs.renameSync(tmp, item.path)
      return
    } catch (e) {
      lastErr = e
      fs.rmSync(tmp, { force: true })
      // откатываем счётчик байт, чтобы прогресс не «убегал» при повторе
      if (got) {
        try {
          onBytes?.(-got)
        } catch {
          /* отмена */
        }
      }
      if (signal?.aborted || isCancel(e)) throw new CancelledError()
      if (e instanceof HttpError && e.status === 404 && urls.length === 1) break
      if (url === item.url) markBad(item.url)
      await new Promise((r) => setTimeout(r, 300 * (i + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Параллельная загрузка с общим прогрессом. Уже скачанные файлы пропускаются. */
export async function downloadAll(
  items: DownloadItem[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number, bytes: number) => void; signal?: AbortSignal } = {}
): Promise<void> {
  const seen = new Set<string>()
  const unique = items.filter((i) => {
    const key = path.resolve(i.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // проверка тысяч ассетов асинхронно и пачками — без подвисания окна
  const queue: DownloadItem[] = []
  for (let i = 0; i < unique.length; i += 256) {
    const part = unique.slice(i, i + 256)
    const present = await Promise.all(part.map(isPresentAsync))
    part.forEach((it, k) => !present[k] && queue.push(it))
  }
  const total = queue.length
  let done = 0
  let bytes = 0
  opts.onProgress?.(0, total, 0)
  const errors: string[] = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (!item || opts.signal?.aborted) return
      try {
        await downloadFile(item, (n) => (bytes += n), 3, opts.signal)
      } catch (e) {
        if (isCancel(e)) return
        errors.push(`${path.basename(item.path)}: ${e instanceof Error ? e.message : e}`)
      }
      done++
      opts.onProgress?.(done, total, bytes)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || 8) }, worker))
  throwIfAborted(opts.signal)
  if (errors.length) {
    throw new Error(
      `Не удалось скачать ${errors.length} файл(ов):\n` +
        errors.slice(0, 6).join('\n') +
        '\n\nЕсли сайты не открываются — включите зеркала или свой VPN/прокси в Настройках → «Сеть».'
    )
  }
}

// ---------------- Свой VPN / прокси ----------------

/** Применяет прокси из настроек ко всем запросам лаунчера (или системный прокси, если выключен). */
export async function applyProxy(): Promise<void> {
  const p = getSettings().proxy
  const config: Electron.ProxyConfig =
    p?.enabled && p.host && p.port
      ? { proxyRules: `${p.type === 'socks5' ? 'socks5' : 'http'}://${p.host}:${p.port}`, proxyBypassRules: '<local>' }
      : { mode: 'system' }
  for (const s of [session.defaultSession, session.fromPartition('persist:aurora-ms')]) {
    await s.setProxy(config)
    await s.closeAllConnections()
  }
  badHosts.clear()
}

/** Проверка доступности сервисов (для кнопки «Проверить соединение»). */
export async function testConnection(): Promise<{ name: string; ok: boolean; ms: number; error?: string }[]> {
  const targets: [string, string][] = [
    ['Modrinth', 'https://api.modrinth.com/v2/tag/loader'],
    ['Зеркало MCIM (Modrinth/CurseForge)', 'https://mod.mcimirror.top/modrinth/v2/tag/loader'],
    ['Mojang', 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'],
    ['Зеркало BMCLAPI (Mojang/Forge)', 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'],
    ['GitHub (обновления)', 'https://api.github.com/repos/KIRILLTAN/aurora-launcher']
  ]
  return Promise.all(
    targets.map(async ([name, url]) => {
      const t = Date.now()
      try {
        const res = await httpFetch(url, { signal: AbortSignal.timeout(10000) })
        return { name, ok: res.ok, ms: Date.now() - t, error: res.ok ? undefined : `HTTP ${res.status}` }
      } catch (e) {
        return { name, ok: false, ms: Date.now() - t, error: (e as Error).message }
      }
    })
  )
}
