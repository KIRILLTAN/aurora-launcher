import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { app } from 'electron'

export const USER_AGENT = `KIRILLTAN/aurora-launcher/${app.getVersion()} (github.com/KIRILLTAN/aurora-launcher)`

export interface DownloadItem {
  url: string
  path: string
  sha1?: string
  size?: number
  /** запасные зеркала */
  mirrors?: string[]
}

export async function fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers || {}) }
  })
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
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} ${url}`)
  return res.text()
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
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

export async function downloadFile(item: DownloadItem, onBytes?: (n: number) => void, attempts = 3): Promise<void> {
  const urls = [item.url, ...(item.mirrors || [])].filter(Boolean)
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    const url = urls[i % urls.length]
    try {
      await fs.promises.mkdir(path.dirname(item.path), { recursive: true })
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } })
      if (!res.ok || !res.body) throw new HttpError(res.status, `HTTP ${res.status} ${url}`)
      const tmp = item.path + '.part'
      const hash = crypto.createHash('sha1')
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk)
          onBytes?.(chunk.length)
          cb(null, chunk)
        }
      })
      await pipeline(Readable.fromWeb(res.body as never), counter, fs.createWriteStream(tmp))
      const digest = hash.digest('hex')
      if (item.sha1 && digest !== item.sha1.toLowerCase()) {
        fs.rmSync(tmp, { force: true })
        throw new Error(`Контрольная сумма не совпала: ${path.basename(item.path)}`)
      }
      fs.renameSync(tmp, item.path)
      return
    } catch (e) {
      lastErr = e
      if (e instanceof HttpError && e.status === 404 && urls.length === 1) break
      await new Promise((r) => setTimeout(r, 400 * (i + 1)))
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** Параллельная загрузка с общим прогрессом. Уже скачанные файлы пропускаются. */
export async function downloadAll(
  items: DownloadItem[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number, bytes: number) => void } = {}
): Promise<void> {
  const seen = new Set<string>()
  const queue = items.filter((i) => {
    const key = path.resolve(i.path)
    if (seen.has(key)) return false
    seen.add(key)
    return !isPresent(i)
  })
  const total = queue.length
  let done = 0
  let bytes = 0
  opts.onProgress?.(0, total, 0)
  const errors: string[] = []
  const worker = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (!item) return
      try {
        await downloadFile(item, (n) => (bytes += n))
      } catch (e) {
        errors.push(`${path.basename(item.path)}: ${e instanceof Error ? e.message : e}`)
      }
      done++
      opts.onProgress?.(done, total, bytes)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency || 8) }, worker))
  if (errors.length) {
    throw new Error(`Не удалось скачать ${errors.length} файл(ов):\n` + errors.slice(0, 6).join('\n'))
  }
}
