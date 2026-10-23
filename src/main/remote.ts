import { app } from 'electron'
import path from 'path'
import { autoUpdater } from 'electron-updater'
import type { RemoteInfo, UpdateStatus } from '@shared/types'
import { getSettings } from './settings'
import { fetchJson } from './util/net'
import { readJson, writeJson } from './util/store'
import { emit } from './events'

/**
 * Онлайн-контент лаунчера берётся прямо из GitHub-репозитория:
 * remote/news.json и remote/featured.json в ветке main.
 * Достаточно отредактировать эти файлы на GitHub — лаунчер подхватит изменения.
 */
export async function getRemoteInfo(): Promise<RemoteInfo> {
  const repo = getSettings().githubRepo || 'KIRILLTAN/aurora-launcher'
  const base = `https://raw.githubusercontent.com/${repo}/main/remote`
  const cache = path.join(app.getPath('userData'), 'remote-cache.json')
  try {
    const [news, featured] = await Promise.all([
      fetchJson<{ motd?: string; items: RemoteInfo['news'] }>(`${base}/news.json?t=${Date.now()}`),
      fetchJson<{ packs: RemoteInfo['featured'] }>(`${base}/featured.json?t=${Date.now()}`)
    ])
    let latestVersion: string | undefined
    try {
      latestVersion = (await fetchJson<{ tag_name: string }>(`https://api.github.com/repos/${repo}/releases/latest`)).tag_name
    } catch {
      /* релизов может ещё не быть */
    }
    const packs = featured.packs || []
    // обложки для сборок с Modrinth подтягиваем автоматически
    await Promise.all(
      packs.map(async (p) => {
        if (p.image || !p.ref.startsWith('modrinth:')) return
        try {
          p.image = (await fetchJson<{ icon_url?: string }>(`https://api.modrinth.com/v2/project/${p.ref.slice(9)}`)).icon_url
        } catch {
          /* без обложки */
        }
      })
    )
    const info: RemoteInfo = { news: news.items || [], featured: packs, motd: news.motd, latestVersion }
    writeJson(cache, info)
    return info
  } catch {
    return readJson<RemoteInfo>(cache, { news: [], featured: [] })
  }
}

let status: UpdateStatus = { state: 'idle' }
function setStatus(s: UpdateStatus): void {
  status = s
  emit('update:status', s)
}
export function getUpdateStatus(): UpdateStatus {
  return status
}

export function initUpdater(): void {
  if (!app.isPackaged) {
    setStatus({ state: 'dev' })
    return
  }
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on('checking-for-update', () => setStatus({ state: 'checking' }))
  autoUpdater.on('update-available', (i) => setStatus({ state: 'available', version: i.version }))
  autoUpdater.on('update-not-available', () => setStatus({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => setStatus({ state: 'downloading', progress: p.percent / 100, version: status.version }))
  autoUpdater.on('update-downloaded', (i) => setStatus({ state: 'ready', version: i.version }))
  autoUpdater.on('error', (e) => setStatus({ state: 'error', error: e.message }))
  if (getSettings().autoUpdate) checkForUpdates()
}

export function checkForUpdates(): void {
  if (!app.isPackaged) return setStatus({ state: 'dev' })
  autoUpdater.checkForUpdates().catch((e) => setStatus({ state: 'error', error: String(e?.message || e) }))
}

export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}
