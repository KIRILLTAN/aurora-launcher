import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import { dirs, getSettings } from '../settings'
import { downloadAll, downloadFile, isPresent, fetchJson, type DownloadItem } from '../util/net'
import { exists, ensureDir } from '../util/store'
import type { TaskHandle } from '../events'
import { resolveVersion, rulesAllow, mavenPath, osName, osArch, type ResolvedVersion, type Library } from './versions'

const LIB_BASE = 'https://libraries.minecraft.net/'
const RESOURCES = 'https://resources.download.minecraft.net/'

export interface LibrarySet {
  classpath: string[]
  downloads: DownloadItem[]
  natives: { jar: string; exclude: string[] }[]
}

function archBits(): string {
  return process.arch === 'x64' || process.arch === 'arm64' ? '64' : '32'
}

function nativeArchMismatch(name: string): boolean {
  const cls = name.split(':')[3] || ''
  if (!cls.startsWith('natives-')) return false
  const arm = cls.includes('arm64') || cls.includes('aarch64')
  const x86 = /-x86$/.test(cls)
  if (arm && process.arch !== 'arm64') return true
  if (!arm && process.arch === 'arm64' && osName() !== 'osx') return true
  if (x86 && process.arch !== 'ia32') return true
  return false
}

export function libraryPath(rel: string): string {
  return path.join(dirs.libraries(), ...rel.split('/'))
}

export function collectLibraries(v: ResolvedVersion): LibrarySet {
  const set: LibrarySet = { classpath: [], downloads: [], natives: [] }
  const seen = new Set<string>()

  for (const lib of v.libraries as Library[]) {
    if (!rulesAllow(lib.rules)) continue
    if (lib.clientreq === false) continue
    if (nativeArchMismatch(lib.name)) continue
    const parts = lib.name.split('@')[0].split(':')
    const key = `${parts[0]}:${parts[1]}:${parts[3] || ''}`

    // Старый формат нативных библиотек (LWJGL 2 и ранний LWJGL 3)
    if (lib.natives) {
      const clsTpl = lib.natives[osName()]
      if (clsTpl) {
        const cls = clsTpl.replace('${arch}', archBits())
        const art = lib.downloads?.classifiers?.[cls]
        const rel = art?.path || mavenPath(`${parts[0]}:${parts[1]}:${parts[2]}:${cls}`)
        const url = art?.url || (lib.url || LIB_BASE).replace(/\/?$/, '/') + rel
        const file = libraryPath(rel)
        set.downloads.push({ url, path: file, sha1: art?.sha1, size: art?.size })
        set.natives.push({ jar: file, exclude: lib.extract?.exclude || ['META-INF/'] })
      }
      if (!lib.downloads?.artifact) continue
    }

    if (seen.has(key)) continue
    seen.add(key)

    const art = lib.downloads?.artifact
    const rel = art?.path || mavenPath(lib.name)
    const file = libraryPath(rel)
    let url = art?.url ?? (lib.url ? lib.url.replace(/\/?$/, '/') + rel : LIB_BASE + rel)
    url = url.replace('http://files.minecraftforge.net/maven/', 'https://maven.minecraftforge.net/')
    if (url) set.downloads.push({ url, path: file, sha1: art?.sha1, size: art?.size })
    set.classpath.push(file)
    if ((parts[3] || '').startsWith('natives-')) set.natives.push({ jar: file, exclude: ['META-INF/'] })
  }
  return set
}

export function clientJarPath(id: string): string {
  return path.join(dirs.versions(), id, `${id}.jar`)
}

export function nativesDir(id: string): string {
  return path.join(dirs.versions(), id, 'natives')
}

interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>
  virtual?: boolean
  map_to_resources?: boolean
}

/** Полная установка версии (ванилла или уже установленный загрузчик): jar, библиотеки, ассеты, нативы. */
export async function installVersion(id: string, task?: TaskHandle, gameDir?: string): Promise<ResolvedVersion> {
  task?.update(0.01, `Чтение версии ${id}`)
  const v = await resolveVersion(id)
  const items: DownloadItem[] = []

  const client = v.downloads?.client
  const rootJar = clientJarPath(v.rootId)
  if (client) items.push({ url: client.url!, path: rootJar, sha1: client.sha1, size: client.size })

  const libs = collectLibraries(v)
  items.push(...libs.downloads)

  // Ассеты
  let assetIndex: AssetIndex | null = null
  if (v.assetIndex) {
    const idxFile = path.join(dirs.assets(), 'indexes', `${v.assetIndex.id}.json`)
    const idxItem = { url: v.assetIndex.url, path: idxFile, sha1: v.assetIndex.sha1, size: v.assetIndex.size }
    if (!isPresent(idxItem)) await downloadFile(idxItem)
    assetIndex = JSON.parse(fs.readFileSync(idxFile, 'utf8')) as AssetIndex
    for (const obj of Object.values(assetIndex.objects)) {
      const sub = obj.hash.slice(0, 2)
      items.push({
        url: RESOURCES + sub + '/' + obj.hash,
        path: path.join(dirs.assets(), 'objects', sub, obj.hash),
        sha1: obj.hash,
        size: obj.size
      })
    }
  }

  // Конфиг логирования (защита от log4shell на старых версиях)
  if (v.logging?.client?.file) {
    const f = v.logging.client.file
    items.push({ url: f.url, path: path.join(dirs.assets(), 'log_configs', f.id), sha1: f.sha1, size: f.size })
  }

  await downloadAll(items, {
    concurrency: getSettings().concurrency,
    onProgress: (done, total) => task?.update(0.05 + 0.9 * (total ? done / total : 1), `Загрузка файлов: ${done}/${total}`)
  })

  // Для версии-наследника нужен свой jar с её id (требование Forge/NeoForge)
  const finalJar = clientJarPath(id)
  if (id !== v.rootId && exists(rootJar) && !exists(finalJar)) {
    ensureDir(path.dirname(finalJar))
    fs.copyFileSync(rootJar, finalJar)
  }

  if (assetIndex && (assetIndex.virtual || assetIndex.map_to_resources)) {
    task?.detail('Подготовка старых ресурсов')
    const target = assetIndex.map_to_resources && gameDir
      ? path.join(gameDir, 'resources')
      : path.join(dirs.assets(), 'virtual', v.assetIndex!.id)
    for (const [name, obj] of Object.entries(assetIndex.objects)) {
      const dst = path.join(target, ...name.split('/'))
      if (exists(dst)) continue
      ensureDir(path.dirname(dst))
      fs.copyFileSync(path.join(dirs.assets(), 'objects', obj.hash.slice(0, 2), obj.hash), dst)
    }
  }

  extractNatives(id, libs)
  task?.update(1, 'Готово')
  return v
}

export function extractNatives(id: string, libs: LibrarySet): void {
  const dir = ensureDir(nativesDir(id))
  for (const n of libs.natives) {
    if (!exists(n.jar)) continue
    try {
      const zip = new AdmZip(n.jar)
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue
        if (n.exclude.some((x) => e.entryName.startsWith(x))) continue
        const base = path.basename(e.entryName)
        if (!/\.(dll|so|dylib|jnilib)$/i.test(base) && e.entryName.includes('/')) continue
        const dst = path.join(dir, base)
        if (exists(dst)) continue
        fs.writeFileSync(dst, e.getData())
      }
    } catch {
      /* битый native-jar будет перекачан при следующей проверке */
    }
  }
}

/** authlib-injector для Ely.by и других Yggdrasil-серверов */
export async function ensureAuthlibInjector(): Promise<string> {
  const dir = ensureDir(path.join(dirs.root(), 'authlib'))
  const file = path.join(dir, 'authlib-injector.jar')
  if (exists(file)) return file
  const meta = await fetchJson<{ download_url: string; version: string }>(
    'https://authlib-injector.yushi.moe/artifact/latest.json'
  )
  await downloadFile({ url: meta.download_url, path: file })
  return file
}

export function archLabel(): string {
  return `${osName()}-${osArch()}`
}
