import fs from 'fs'
import os from 'os'
import path from 'path'
import { app, shell } from 'electron'
import type { Instance, SyncRemoteInstance, SyncStatus } from '@shared/types'
import { getSettings } from './settings'
import { createInstance, gameDir, getInstance, listInstances, saveInstance } from './instances'
import { fetchJson, httpFetch, downloadAll, sha1File, USER_AGENT, type DownloadItem } from './util/net'
import { readJson, writeJson, exists, ensureDir, safeJoin } from './util/store'
import { sealJson, unsealJson } from './util/secure'
import { emit, withTask, withCancellableTask, type TaskHandle } from "./events"
import { HELPER_FILE } from './helper'
import { cfPost } from './catalog/curseforge'
import { ensureInstalled } from './minecraft/launch'

/*
 * Синхронизация сборок между компьютерами.
 * Хранилище — приватный GitHub Gist пользователя или любая облачная папка
 * (Яндекс Диск, OneDrive, Google Drive). В облако уходит «манифест» сборки:
 * версия, загрузчик, настройки, список модов со ссылками (Modrinth/CurseForge)
 * и конфиги. На другом ПК сборка собирается из манифеста 1 в 1.
 */

const GIST_DESC = 'Aurora Launcher Sync'
const INDEX = 'aurora-index.json'
const CONTENT_DIRS = ['mods', 'resourcepacks', 'shaderpacks']
const CONFIG_DIRS = ['config', 'kubejs', 'defaultconfigs', 'scripts', 'global_packs']
const CONFIG_FILES = ['options.txt', 'servers.dat', 'optionsof.txt', 'optionsshaders.txt']
const MAX_CONFIG_FILE = 512 * 1024
const MAX_CONFIG_TOTAL = 3 * 1024 * 1024

interface SyncConfig {
  provider?: 'github' | 'folder'
  token?: string
  login?: string
  avatar?: string
  gistId?: string
  folder?: string
  lastSync?: number
}

interface SyncFile {
  path: string
  sha1: string
  size: number
  url?: string
  source: 'modrinth' | 'curseforge' | 'blob' | 'missing'
}

interface SyncManifest {
  format: 1
  instance: Omit<Instance, 'versionId' | 'lastPlayed' | 'playTime'>
  files: SyncFile[]
  configs: { path: string; data: string }[]
  skippedConfigs: string[]
  updatedAt: number
  device: string
}

interface SyncIndex {
  format: 1
  instances: SyncRemoteInstance[]
}

const cfgFile = (): string => path.join(app.getPath('userData'), 'sync.json')
const loadCfg = (): SyncConfig => readJson<SyncConfig>(cfgFile(), {})
const saveCfg = (c: SyncConfig): void => writeJson(cfgFile(), c)
const device = (): string => os.hostname()
const key = (id: string): string => `instance-${Buffer.from(id).toString('base64url')}.json`

export function syncStatus(): SyncStatus {
  const c = loadCfg()
  return {
    connected: !!c.provider,
    provider: c.provider,
    login: c.login,
    avatar: c.avatar,
    folder: c.folder,
    lastSync: c.lastSync,
    device: device(),
    githubLoginAvailable: !!getSettings().githubClientId
  }
}

// ---------------- Хранилища ----------------

interface Provider {
  read(name: string): Promise<string | null>
  write(changes: Record<string, string | null>): Promise<void>
  putBlob?(sha1: string, file: string): Promise<void>
  blobPath?(sha1: string): string | null
}

function gh(token: string) {
  return async <T,>(p: string, init: RequestInit = {}): Promise<T> => {
    const res = await httpFetch('https://api.github.com' + p, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': USER_AGENT,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {})
      }
    })
    if (res.status === 401) throw new Error('GitHub: токен недействителен — войдите заново во вкладке «Аккаунты»')
    if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return (await res.json()) as T
  }
}

interface Gist {
  id: string
  description: string
  files: Record<string, { filename: string; content?: string; truncated?: boolean; raw_url: string }>
}

async function githubProvider(c: SyncConfig): Promise<Provider> {
  const token = unsealJson<string>(c.token)
  if (!token) throw new Error('Нет токена GitHub — войдите заново')
  const api = gh(token)
  if (!c.gistId) {
    const list = await api<Gist[]>('/gists?per_page=100')
    let g = list.find((x) => x.description === GIST_DESC)
    if (!g) {
      g = await api<Gist>('/gists', {
        method: 'POST',
        body: JSON.stringify({ description: GIST_DESC, public: false, files: { [INDEX]: { content: JSON.stringify({ format: 1, instances: [] }) } } })
      })
    }
    c.gistId = g.id
    saveCfg(c)
  }
  let cache: Gist | null = null
  const gist = async (): Promise<Gist> => (cache ||= await api<Gist>(`/gists/${c.gistId}`))
  return {
    async read(name) {
      const f = (await gist()).files[name]
      if (!f) return null
      if (f.truncated || f.content === undefined) {
        const r = await httpFetch(f.raw_url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT } })
        return r.ok ? r.text() : null
      }
      return f.content
    },
    async write(changes) {
      const files: Record<string, { content: string } | null> = {}
      for (const [k, v] of Object.entries(changes)) files[k] = v === null ? null : { content: v }
      cache = await api<Gist>(`/gists/${c.gistId}`, { method: 'PATCH', body: JSON.stringify({ files }) })
    }
  }
}

function folderProvider(c: SyncConfig): Provider {
  const root = ensureDir(path.join(c.folder!, 'AuroraSync'))
  const blobs = path.join(root, 'blobs')
  return {
    async read(name) {
      const f = path.join(root, name)
      return exists(f) ? fs.readFileSync(f, 'utf8') : null
    },
    async write(changes) {
      for (const [k, v] of Object.entries(changes)) {
        const f = path.join(root, k)
        if (v === null) fs.rmSync(f, { force: true })
        else fs.writeFileSync(f, v)
      }
    },
    async putBlob(sha1, file) {
      const dst = path.join(ensureDir(blobs), sha1)
      if (!exists(dst)) fs.copyFileSync(file, dst)
    },
    blobPath(sha1) {
      const p = path.join(blobs, sha1)
      return exists(p) ? p : null
    }
  }
}

async function provider(): Promise<Provider> {
  const c = loadCfg()
  if (c.provider === 'github') return githubProvider(c)
  if (c.provider === 'folder' && c.folder) return folderProvider(c)
  throw new Error('Синхронизация не подключена — откройте «Аккаунты» → «Облако Aurora»')
}

// ---------------- Вход ----------------

let pendingLogin: { cancel: boolean } | null = null

/** Вход через GitHub (device flow): пользователь вводит код на github.com/login/device. */
export async function startGithubLogin(): Promise<{ userCode: string; uri: string }> {
  const clientId = getSettings().githubClientId
  if (!clientId) throw new Error('Не задан GitHub OAuth Client ID (Настройки → Онлайн). Можно войти по токену.')
  const r = await fetchJson<{ device_code: string; user_code: string; verification_uri: string; interval: number; expires_in: number }>(
    'https://github.com/login/device/code',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: clientId, scope: 'gist read:user' }) }
  )
  if (pendingLogin) pendingLogin.cancel = true
  const state = { cancel: false }
  pendingLogin = state
  void (async () => {
    let interval = (r.interval || 5) * 1000
    const until = Date.now() + r.expires_in * 1000
    while (!state.cancel && Date.now() < until) {
      await new Promise((res) => setTimeout(res, interval))
      const t = await fetchJson<{ access_token?: string; error?: string }>('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, device_code: r.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
      }).catch(() => ({ error: 'network' }) as { access_token?: string; error?: string })
      if (t.access_token) {
        try {
          await loginGithubToken(t.access_token)
        } catch (e) {
          emit('sync:login', { ok: false, error: (e as Error).message })
        }
        return
      }
      if (t.error === 'slow_down') interval += 5000
      else if (t.error === 'expired_token' || t.error === 'access_denied') {
        emit('sync:login', { ok: false, error: t.error === 'access_denied' ? 'Вход отклонён' : 'Код истёк — попробуйте снова' })
        return
      }
    }
  })()
  shell.openExternal(r.verification_uri)
  return { userCode: r.user_code, uri: r.verification_uri }
}

export async function loginGithubToken(token: string): Promise<SyncStatus> {
  const user = await gh(token.trim())<{ login: string; avatar_url: string }>('/user')
  saveCfg({ provider: 'github', token: sealJson(token.trim()), login: user.login, avatar: user.avatar_url })
  await githubProvider(loadCfg())
  const s = syncStatus()
  emit('sync:login', { ok: true, status: s })
  return s
}

export function useFolder(folder: string): SyncStatus {
  ensureDir(path.join(folder, 'AuroraSync'))
  saveCfg({ provider: 'folder', folder })
  return syncStatus()
}

export function disconnect(): SyncStatus {
  saveCfg({})
  return syncStatus()
}

// ---------------- Манифест ----------------

/** Отпечаток CurseForge: MurmurHash2 (seed 1) без пробельных байтов. */
function cfFingerprint(buf: Buffer): number {
  const data = buf.filter((b) => b !== 9 && b !== 10 && b !== 13 && b !== 32)
  const m = 0x5bd1e995
  let len = data.length
  let h = (1 ^ len) >>> 0
  let i = 0
  while (len >= 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)
    k = Math.imul(k, m)
    k ^= k >>> 24
    k = Math.imul(k, m)
    h = Math.imul(h, m) ^ k
    i += 4
    len -= 4
  }
  if (len === 3) h ^= data[i + 2] << 16
  if (len >= 2) h ^= data[i + 1] << 8
  if (len >= 1) {
    h ^= data[i]
    h = Math.imul(h, m)
  }
  h ^= h >>> 13
  h = Math.imul(h, m)
  h ^= h >>> 15
  return h >>> 0
}

function walk(dir: string, base: string, out: string[]): void {
  if (!exists(dir)) return
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, base, out)
    else out.push(path.relative(base, p).split(path.sep).join('/'))
  }
}

async function buildManifest(inst: Instance, prov: Provider, task?: TaskHandle): Promise<SyncManifest> {
  const gdir = gameDir(inst.id)
  const files: SyncFile[] = []
  for (const d of CONTENT_DIRS) {
    const dir = path.join(gdir, d)
    if (!exists(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (name === HELPER_FILE || !/\.(jar|zip)(\.disabled)?$/i.test(name)) continue
      const full = path.join(dir, name)
      if (!fs.statSync(full).isFile()) continue
      files.push({ path: `${d}/${name}`, sha1: await sha1File(full), size: fs.statSync(full).size, source: 'missing' })
    }
  }
  task?.update(0.3, `Поиск ${files.length} файлов на Modrinth`)
  if (files.length) {
    const res = await fetchJson<Record<string, { files: { url: string; hashes: { sha1: string } }[] }>>('https://api.modrinth.com/v2/version_files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hashes: files.map((f) => f.sha1), algorithm: 'sha1' })
    }).catch(() => ({}) as Record<string, { files: { url: string; hashes: { sha1: string } }[] }>)
    for (const f of files) {
      const file = res[f.sha1]?.files.find((x) => x.hashes.sha1 === f.sha1)
      if (file) {
        f.url = file.url
        f.source = 'modrinth'
      }
    }
  }
  const rest = files.filter((f) => f.source === 'missing')
  if (rest.length && getSettings().curseforgeKey) {
    task?.update(0.5, `Поиск ${rest.length} файлов на CurseForge`)
    try {
      const prints = new Map<number, SyncFile>()
      for (const f of rest) prints.set(cfFingerprint(fs.readFileSync(path.join(gdir, f.path))), f)
      const r = await cfPost<{ data: { exactMatches: { file: { id: number; fileName: string; downloadUrl: string | null; fileFingerprint: number } }[] } }>(
        '/fingerprints/432',
        { fingerprints: [...prints.keys()] }
      )
      for (const m of r.data.exactMatches) {
        const f = prints.get(m.file.fileFingerprint)
        if (!f) continue
        const id = String(m.file.id)
        f.url = m.file.downloadUrl || `https://edge.forgecdn.net/files/${id.slice(0, -3)}/${parseInt(id.slice(-3))}/${encodeURIComponent(m.file.fileName)}`
        f.source = 'curseforge'
      }
    } catch {
      /* без CurseForge */
    }
  }
  if (prov.putBlob) {
    for (const f of files.filter((x) => x.source === 'missing')) {
      await prov.putBlob(f.sha1, path.join(gdir, f.path))
      f.source = 'blob'
    }
  }

  task?.update(0.7, 'Упаковка конфигов')
  const configs: SyncManifest['configs'] = []
  const skipped: string[] = []
  let total = 0
  const candidates: string[] = []
  for (const d of CONFIG_DIRS) walk(path.join(gdir, d), gdir, candidates)
  for (const f of CONFIG_FILES) if (exists(path.join(gdir, f))) candidates.push(f)
  for (const rel of candidates) {
    const size = fs.statSync(path.join(gdir, rel)).size
    if (size > MAX_CONFIG_FILE || total + size > MAX_CONFIG_TOTAL) {
      skipped.push(rel)
      continue
    }
    total += size
    configs.push({ path: rel, data: fs.readFileSync(path.join(gdir, rel)).toString('base64') })
  }

  const { versionId: _v, lastPlayed: _l, playTime: _p, ...meta } = inst
  return { format: 1, instance: meta, files, configs, skippedConfigs: skipped, updatedAt: Date.now(), device: device() }
}

// ---------------- Отправка и загрузка ----------------

async function readIndex(prov: Provider): Promise<SyncIndex> {
  const raw = await prov.read(INDEX)
  try {
    const idx = raw ? (JSON.parse(raw) as SyncIndex) : null
    if (idx?.instances) return idx
  } catch {
    /* повреждён — пересоздадим */
  }
  return { format: 1, instances: [] }
}

export function pushInstances(ids?: string[]): Promise<{ pushed: number; missing: string[] }> {
  return withTask('Синхронизация: отправка в облако', async (t) => {
    const prov = await provider()
    const list = ids ? ids.map(getInstance) : listInstances()
    const idx = await readIndex(prov)
    const changes: Record<string, string | null> = {}
    const missing: string[] = []
    for (let i = 0; i < list.length; i++) {
      const inst = list[i]
      t.update(i / list.length, inst.name)
      const man = await buildManifest(inst, prov)
      missing.push(...man.files.filter((f) => f.source === 'missing').map((f) => `${inst.name}: ${f.path}`))
      changes[key(inst.id)] = JSON.stringify(man)
      const entry: SyncRemoteInstance = {
        id: inst.id,
        name: inst.name,
        mcVersion: inst.mcVersion,
        loader: inst.loader,
        loaderVersion: inst.loaderVersion,
        icon: inst.icon,
        updatedAt: man.updatedAt,
        device: man.device,
        files: man.files.length
      }
      idx.instances = [entry, ...idx.instances.filter((x) => x.id !== inst.id)]
      saveInstance({ ...inst, syncedAt: man.updatedAt })
    }
    changes[INDEX] = JSON.stringify(idx)
    await prov.write(changes)
    const c = loadCfg()
    saveCfg({ ...c, lastSync: Date.now() })
    t.done(missing.length ? `Не найдено в каталогах: ${missing.length} файл(ов)` : `Отправлено сборок: ${list.length}`)
    return { pushed: list.length, missing }
  })
}

export async function listRemote(): Promise<SyncRemoteInstance[]> {
  const prov = await provider()
  const idx = await readIndex(prov)
  const local = new Map(listInstances().map((i) => [i.id, i]))
  const me = device()
  return idx.instances.map((r) => {
    const l = local.get(r.id)
    let state: SyncRemoteInstance['state'] = 'synced'
    if (!l) state = 'cloud'
    else if (r.updatedAt > (l.syncedAt || 0) && r.device !== me) state = 'cloud-newer'
    return { ...r, state }
  })
}

export function removeRemote(id: string): Promise<void> {
  return withTask('Удаление из облака', async () => {
    const prov = await provider()
    const idx = await readIndex(prov)
    idx.instances = idx.instances.filter((x) => x.id !== id)
    await prov.write({ [INDEX]: JSON.stringify(idx), [key(id)]: null })
  })
}

/** Скачивает сборку из облака и собирает её 1 в 1. */
export function pullInstance(id: string): Promise<Instance> {
  return withCancellableTask("Синхронизация: загрузка из облака", async (t) => {
    const prov = await provider()
    const raw = await prov.read(key(id))
    if (!raw) throw new Error('Сборка не найдена в облаке')
    const man = JSON.parse(raw) as SyncManifest
    t.detail(man.instance.name)
    let inst: Instance
    try {
      const cur = getInstance(id)
      const sameVersion = cur.mcVersion === man.instance.mcVersion && cur.loader === man.instance.loader && cur.loaderVersion === man.instance.loaderVersion
      inst = saveInstance({ ...cur, ...man.instance, id, versionId: sameVersion ? cur.versionId : undefined })
    } catch {
      inst = createInstance({ ...man.instance }, id)
    }
    const gdir = gameDir(id)

    // удаляем лишние моды/паки, которых нет в облачной версии
    const wanted = new Set(man.files.map((f) => f.path))
    for (const d of CONTENT_DIRS) {
      const dir = path.join(gdir, d)
      if (!exists(dir)) continue
      for (const name of fs.readdirSync(dir)) {
        if (name === HELPER_FILE || !/\.(jar|zip)(\.disabled)?$/i.test(name)) continue
        if (!wanted.has(`${d}/${name}`)) fs.rmSync(path.join(dir, name), { force: true })
      }
    }

    const items: DownloadItem[] = []
    const missing: string[] = []
    for (const f of man.files) {
      const dst = safeJoin(gdir, f.path)
      if (exists(dst) && (await sha1File(dst)) === f.sha1) continue
      if (f.url) items.push({ url: f.url, path: dst, sha1: f.sha1, size: f.size })
      else {
        const blob = prov.blobPath?.(f.sha1)
        if (blob) {
          ensureDir(path.dirname(dst))
          fs.copyFileSync(blob, dst)
        } else missing.push(f.path)
      }
    }
    await downloadAll(items, {
      concurrency: getSettings().concurrency,
      signal: t.signal,
      onProgress: (d, n) => t.update(0.05 + 0.45 * (n ? d / n : 1), `Файлы: ${d}/${n}`)
    })
    for (const c of man.configs) {
      const dst = safeJoin(gdir, c.path)
      ensureDir(path.dirname(dst))
      fs.writeFileSync(dst, Buffer.from(c.data, 'base64'))
    }
    t.detail('Установка Minecraft и загрузчика')
    await ensureInstalled(getInstance(id), t)
    inst = saveInstance({ ...getInstance(id), syncedAt: man.updatedAt })
    t.done(missing.length ? `Не удалось перенести: ${missing.join(', ')}` : 'Сборка перенесена 1 в 1')
    return inst
  })
}

/** Автоотправка после игры (тихо, без ошибок в интерфейсе). */
export async function autoPush(id: string): Promise<void> {
  const c = loadCfg()
  if (!c.provider || !getSettings().syncAuto) return
  try {
    await pushInstances([id])
  } catch {
    /* нет сети — отправим в следующий раз */
  }
}
