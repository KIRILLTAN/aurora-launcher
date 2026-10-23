import fs from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import yauzl from 'yauzl'
import { CancelledError } from './cancel'

/*
 * Асинхронная работа с zip/jar без загрузки архива в память целиком.
 * adm-zip читает весь файл синхронно — на больших модах и модпаках это
 * подвешивало главный процесс (а вместе с ним и окно) на секунды.
 */

export function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(err || new Error('Не удалось открыть архив')) : resolve(zip)))
  )
}

/** Обходит оглавление; visit может вернуть Promise — следующий файл читается после него. */
export async function walkZip(file: string, visit: (e: yauzl.Entry, zip: yauzl.ZipFile) => void | boolean | Promise<void | boolean>): Promise<void> {
  const zip = await openZip(file)
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (e: yauzl.Entry) => {
        Promise.resolve(visit(e, zip)).then(
          (stop) => (stop === true ? resolve() : zip.readEntry()),
          reject
        )
      })
      zip.on('end', resolve)
      zip.on('error', reject)
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

export function entryStream(zip: yauzl.ZipFile, e: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => zip.openReadStream(e, (err, s) => (err || !s ? reject(err || new Error('read')) : resolve(s))))
}

export async function entryBuffer(zip: yauzl.ZipFile, e: yauzl.Entry): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of (await entryStream(zip, e)) as AsyncIterable<Buffer>) chunks.push(c)
  return Buffer.concat(chunks)
}

export async function zipEntryNames(file: string): Promise<string[]> {
  const names: string[] = []
  await walkZip(file, (e) => void names.push(e.fileName))
  return names
}

/** Читает несколько файлов из архива за один проход. */
export async function readZipFiles(file: string, names: string[]): Promise<Map<string, Buffer>> {
  const want = new Set(names)
  const out = new Map<string, Buffer>()
  await walkZip(file, async (e, zip) => {
    if (!want.has(e.fileName)) return
    out.set(e.fileName, await entryBuffer(zip, e))
    return out.size === want.size
  })
  return out
}

export async function readZipText(file: string, name: string): Promise<string | null> {
  return (await readZipFiles(file, [name])).get(name)?.toString('utf8') ?? null
}

/**
 * Распаковка: target(name) возвращает путь назначения или null, чтобы пропустить файл.
 * Между файлами отдаёт управление циклу событий — окно не замирает.
 */
export async function extractZip(file: string, target: (name: string) => string | null, signal?: AbortSignal, onFile?: (name: string) => void): Promise<number> {
  let n = 0
  const made = new Set<string>()
  await walkZip(file, async (e, zip) => {
    if (signal?.aborted) throw new CancelledError()
    if (e.fileName.endsWith('/')) return
    const dst = target(e.fileName.replace(/\\/g, '/'))
    if (!dst) return
    const dir = path.dirname(dst)
    if (!made.has(dir)) {
      await fs.promises.mkdir(dir, { recursive: true })
      made.add(dir)
    }
    await pipeline(await entryStream(zip, e), fs.createWriteStream(dst))
    // права на запуск (bin/java в архивах JDK)
    const mode = (e.externalFileAttributes >>> 16) & 0o777
    if (mode & 0o111 && process.platform !== 'win32') await fs.promises.chmod(dst, mode).catch(() => undefined)
    n++
    onFile?.(e.fileName)
  })
  return n
}
