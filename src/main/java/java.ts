import fs from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import AdmZip from 'adm-zip'
import * as tar from 'tar'
import type { JavaInstall, JavaRelease } from '@shared/types'
import { app } from 'electron'
import { dirs } from '../settings'
import { fetchJson, downloadFile } from '../util/net'
import { readJson, writeJson, exists, ensureDir } from '../util/store'
import type { TaskHandle } from '../events'
import { compareMc } from '../minecraft/versions'

const isWin = process.platform === 'win32'
const exe = isWin ? 'java.exe' : 'java'
const listFile = (): string => path.join(app.getPath('userData'), 'java.json')

interface JavaStore {
  installs: JavaInstall[]
  manual: string[]
}

function load(): JavaStore {
  return readJson<JavaStore>(listFile(), { installs: [], manual: [] })
}
function save(s: JavaStore): void {
  writeJson(listFile(), s)
}

/** Определяет версию, разрядность и производителя Java. */
export function probeJava(javaPath: string): Promise<Omit<JavaInstall, 'source'> | null> {
  return new Promise((resolve) => {
    execFile(javaPath, ['-XshowSettings:properties', '-version'], { timeout: 15000, windowsHide: true }, (_err, stdout, stderr) => {
      const out = `${stdout}\n${stderr}`
      const ver = /java\.version = (\S+)/.exec(out)?.[1] || /version "([^"]+)"/.exec(out)?.[1]
      if (!ver) return resolve(null)
      const arch = /os\.arch = (\S+)/.exec(out)?.[1] || 'unknown'
      const vendor = /java\.vendor = (.+)/.exec(out)?.[1]?.trim()
      resolve({ path: javaPath, version: ver, major: majorOf(ver), arch, vendor })
    })
  })
}

export function majorOf(ver: string): number {
  const p = ver.split(/[._+-]/)
  const first = parseInt(p[0])
  return first === 1 ? parseInt(p[1]) : first
}

function candidateRoots(): string[] {
  const home = os.homedir()
  const roots: string[] = [dirs.java(), path.join(home, '.jdks')]
  if (isWin) {
    const pf = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['ProgramW6432']].filter(Boolean) as string[]
    for (const base of pf) {
      for (const v of ['Java', 'Eclipse Adoptium', 'Eclipse Foundation', 'AdoptOpenJDK', 'Zulu', 'Microsoft', 'BellSoft', 'Amazon Corretto', 'Semeru', 'Temurin', 'GraalVM']) {
        roots.push(path.join(base, v))
      }
    }
    const appData = process.env['APPDATA'] || ''
    const local = process.env['LOCALAPPDATA'] || ''
    roots.push(path.join(appData, '.minecraft', 'runtime'))
    roots.push(path.join(local, 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'))
    roots.push(path.join(appData, 'PrismLauncher', 'java'))
  } else if (process.platform === 'darwin') {
    roots.push('/Library/Java/JavaVirtualMachines', path.join(home, 'Library/Java/JavaVirtualMachines'))
    roots.push(path.join(home, 'Library/Application Support/minecraft/runtime'))
  } else {
    roots.push('/usr/lib/jvm', '/usr/java', '/opt', path.join(home, '.minecraft/runtime'), path.join(home, '.local/share/PrismLauncher/java'))
  }
  return roots
}

/** Ищет bin/java на глубину до 4 уровней. */
function findJavaBins(root: string, depth = 4, acc: string[] = []): string[] {
  if (depth < 0 || !exists(root)) return acc
  const bin = path.join(root, 'bin', exe)
  if (exists(bin)) {
    acc.push(bin)
    return acc
  }
  let entries: fs.Dirent[] = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) if (e.isDirectory()) findJavaBins(path.join(root, e.name), depth - 1, acc)
  return acc
}

function pathJavas(): string[] {
  const found: string[] = []
  const javaHome = process.env['JAVA_HOME']
  if (javaHome) found.push(path.join(javaHome, 'bin', exe))
  for (const dir of (process.env['PATH'] || '').split(path.delimiter)) {
    const p = path.join(dir, exe)
    if (dir && exists(p)) found.push(p)
  }
  return found
}

export async function detectJavas(): Promise<JavaInstall[]> {
  const store = load()
  const candidates = new Set<string>()
  for (const r of candidateRoots()) for (const b of findJavaBins(r)) candidates.add(path.resolve(b))
  for (const p of pathJavas()) candidates.add(path.resolve(p))
  for (const m of store.manual) candidates.add(path.resolve(m))

  const results: JavaInstall[] = []
  const seenReal = new Set<string>()
  await Promise.all(
    [...candidates].map(async (c) => {
      if (!exists(c)) return
      let real = c
      try {
        real = fs.realpathSync(c)
      } catch {
        /* ignore */
      }
      if (seenReal.has(real.toLowerCase())) return
      seenReal.add(real.toLowerCase())
      const info = await probeJava(c)
      if (!info) return
      const source: JavaInstall['source'] = c.startsWith(path.resolve(dirs.java()))
        ? 'aurora'
        : store.manual.some((m) => path.resolve(m) === c)
          ? 'manual'
          : 'detected'
      results.push({ ...info, source })
    })
  )
  results.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path))
  save({ ...store, installs: results })
  return results
}

export function cachedJavas(): JavaInstall[] {
  return load().installs
}

export async function addManualJava(javaPath: string): Promise<JavaInstall> {
  let p = javaPath
  if (exists(p) && fs.statSync(p).isDirectory()) {
    const bins = findJavaBins(p, 3)
    if (!bins.length) throw new Error('В папке не найден bin/' + exe)
    p = bins[0]
  }
  const info = await probeJava(p)
  if (!info) throw new Error('Это не похоже на рабочую Java: ' + p)
  const store = load()
  if (!store.manual.includes(p)) store.manual.push(p)
  const inst: JavaInstall = { ...info, source: 'manual' }
  store.installs = [inst, ...store.installs.filter((i) => path.resolve(i.path) !== path.resolve(p))]
  save(store)
  return inst
}

export function removeJava(javaPath: string): void {
  const store = load()
  store.manual = store.manual.filter((m) => path.resolve(m) !== path.resolve(javaPath))
  store.installs = store.installs.filter((i) => path.resolve(i.path) !== path.resolve(javaPath))
  const auroraRoot = path.resolve(dirs.java())
  if (path.resolve(javaPath).startsWith(auroraRoot + path.sep)) {
    const rel = path.relative(auroraRoot, javaPath).split(path.sep)[0]
    if (rel) fs.rmSync(path.join(auroraRoot, rel), { recursive: true, force: true })
  }
  save(store)
}

/** Подсказка: для каких версий Minecraft подходит Java. */
export function javaHint(major: number): { recommendedFor: string; hint: string } {
  if (major <= 7) return { recommendedFor: 'Очень старые версии (до 1.6)', hint: 'Устарела, лучше взять Java 8' }
  if (major === 8) return { recommendedFor: 'Minecraft 1.0 – 1.16.5', hint: 'Нужна для старых сборок Forge (1.7.10, 1.12.2, 1.16.5)' }
  if (major < 16) return { recommendedFor: 'Minecraft 1.13 – 1.16.5', hint: 'Работает, но Java 8 надёжнее для модов этих версий' }
  if (major === 16) return { recommendedFor: 'Minecraft 1.17.x', hint: 'Минимум для 1.17; можно взять Java 17' }
  if (major === 17) return { recommendedFor: 'Minecraft 1.18 – 1.20.4', hint: 'Основная Java для модов 1.18–1.20.4' }
  if (major < 21) return { recommendedFor: 'Minecraft 1.18 – 1.20.4', hint: 'Не LTS — лучше Java 17' }
  if (major === 21) return { recommendedFor: 'Minecraft 1.20.5 – 1.21.x', hint: 'Нужна для 1.20.5 и новее' }
  if (major < 25) return { recommendedFor: 'Minecraft 1.20.5 – 1.21.x', hint: 'Не LTS — лучше Java 21' }
  if (major === 25) return { recommendedFor: 'Minecraft 26.1 и новее', hint: 'Новая LTS, требуется для новых версий' }
  return { recommendedFor: 'Будущие версии Minecraft', hint: 'Экспериментально — для игры лучше LTS' }
}

/** Какая Java нужна версии Minecraft. */
export function requiredJavaMajor(mcVersion: string, fromJson?: number): number {
  if (fromJson) return fromJson
  if (/^\d{2}\./.test(mcVersion)) return 25
  if (compareMc(mcVersion, '1.20.5') >= 0) return 21
  if (compareMc(mcVersion, '1.18') >= 0) return 17
  if (compareMc(mcVersion, '1.17') >= 0) return 16
  return 8
}

/** Подбирает установленную Java: точное совпадение мажорной версии, иначе ближайшая подходящая. */
export function pickJava(required: number, installs = cachedJavas()): JavaInstall | undefined {
  const x64 = installs.filter((i) => !/x86$|i386|i686/.test(i.arch) || process.arch === 'ia32')
  const exact = x64.filter((i) => i.major === required)
  const rank = (i: JavaInstall): number => (i.source === 'aurora' ? 0 : 1)
  if (exact.length) return exact.sort((a, b) => rank(a) - rank(b))[0]
  // Старые версии (Java 8) часто ломаются на новых Java — ищем только >= required и для 8 не подменяем
  if (required === 8) return undefined
  return x64.filter((i) => i.major > required && i.major - required <= 8).sort((a, b) => a.major - b.major)[0]
}

/** Для запуска на Windows используем javaw.exe, чтобы не мигала консоль. */
export function launchBinary(javaPath: string): string {
  if (!isWin) return javaPath
  const w = path.join(path.dirname(javaPath), 'javaw.exe')
  return exists(w) ? w : javaPath
}

interface AdoptiumRelease {
  available_releases: number[]
  available_lts_releases: number[]
  most_recent_lts: number
}

export async function availableJavaReleases(): Promise<JavaRelease[]> {
  const r = await fetchJson<AdoptiumRelease>('https://api.adoptium.net/v3/info/available_releases')
  return r.available_releases
    .filter((m) => m >= 8)
    .sort((a, b) => b - a)
    .map((major) => ({ major, lts: r.available_lts_releases.includes(major), ...javaHint(major) }))
}

interface AdoptiumAsset {
  binary: { package: { link: string; name: string; size: number; checksum: string }; image_type: string }
  release_name: string
}

function adoptiumOs(): string {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
}
function adoptiumArch(): string {
  return process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'aarch64' : process.arch === 'ia32' ? 'x32' : process.arch
}

/** Скачивает Eclipse Temurin нужной версии в папку лаунчера. */
export async function installJava(major: number, task?: TaskHandle, imageType: 'jre' | 'jdk' = 'jre'): Promise<JavaInstall> {
  const q = (type: string): string =>
    `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${adoptiumArch()}&image_type=${type}&os=${adoptiumOs()}&vendor=eclipse`
  let assets = await fetchJson<AdoptiumAsset[]>(q(imageType)).catch(() => [] as AdoptiumAsset[])
  if (!assets.length) assets = await fetchJson<AdoptiumAsset[]>(q(imageType === 'jre' ? 'jdk' : 'jre'))
  const asset = assets[0]
  if (!asset) throw new Error(`Java ${major} недоступна для этой системы`)
  const pkg = asset.binary.package
  const archive = path.join(dirs.cache(), pkg.name)
  let downloaded = 0
  task?.update(0.02, `Скачивание ${asset.release_name}`)
  await downloadFile({ url: pkg.link, path: archive, size: pkg.size }, (n) => {
    downloaded += n
    task?.update(0.02 + 0.8 * (downloaded / pkg.size), `Скачивание ${asset.release_name}: ${(downloaded / 1048576).toFixed(0)} / ${(pkg.size / 1048576).toFixed(0)} МБ`)
  })
  const dest = ensureDir(path.join(dirs.java(), `${asset.binary.image_type}-${major}-${asset.release_name}`))
  task?.update(0.85, 'Распаковка')
  if (pkg.name.endsWith('.zip')) {
    await new Promise<void>((res, rej) => new AdmZip(archive).extractAllToAsync(dest, true, false, (e) => (e ? rej(e) : res())))
  } else {
    await tar.x({ file: archive, cwd: dest })
  }
  fs.rmSync(archive, { force: true })
  const bins = findJavaBins(dest, 5)
  if (!bins.length) throw new Error('После распаковки не найден исполняемый файл java')
  if (!isWin) fs.chmodSync(bins[0], 0o755)
  const info = await probeJava(bins[0])
  if (!info) throw new Error('Установленная Java не запускается')
  const inst: JavaInstall = { ...info, source: 'aurora' }
  const store = load()
  store.installs = [inst, ...store.installs.filter((i) => i.path !== inst.path)]
  save(store)
  task?.update(1, `Java ${major} установлена`)
  return inst
}
