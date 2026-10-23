import fs from 'fs'
import path from 'path'

export function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

export function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

/** Защита от путей вида ../../ из архивов и индексов сборок. */
export function safeJoin(root: string, rel: string): string {
  const target = path.resolve(root, rel)
  const base = path.resolve(root)
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error(`Небезопасный путь в архиве: ${rel}`)
  }
  return target
}

export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * Рекурсивное копирование папки. fs.cpSync на Windows падает с «EPERM, Неверная функция»
 * на путях с русскими буквами, поэтому копируем сами.
 */
export async function copyDir(src: string, dst: string): Promise<void> {
  await fs.promises.mkdir(dst, { recursive: true })
  for (const e of await fs.promises.readdir(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) await copyDir(s, d)
    else if (e.isFile()) await fs.promises.copyFile(s, d)
  }
}
