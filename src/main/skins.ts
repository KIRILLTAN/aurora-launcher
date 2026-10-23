import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import { dirs } from './settings'
import { USER_AGENT, fetchJson, httpFetch } from './util/net'
import { getMicrosoftToken, getMcProfile, updateAccountSkin, setOfflineAccountSkin } from './auth/accounts'

/** Скачивает картинку (скин/плащ) и отдаёт data URL — обходит CORS в интерфейсе. */
export async function fetchImage(url: string): Promise<string> {
  if (!/^https?:/i.test(url)) {
    // локальный файл (скин оффлайн-аккаунта) — только из папки лаунчера
    const file = path.resolve(url.split('#')[0])
    if (!file.startsWith(path.resolve(app.getPath('userData'), 'offline-skins'))) throw new Error('Недопустимый путь')
    return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64')
  }
  const res = await httpFetch(url, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return `data:${res.headers.get('content-type') || 'image/png'};base64,${buf.toString('base64')}`
}

/** Скин игрока по нику: Mojang, затем Ely.by. */
export async function skinByName(name: string, source: 'mojang' | 'ely'): Promise<{ data: string; slim: boolean }> {
  if (source === 'ely') {
    const data = await fetchImage(`http://skinsystem.ely.by/skins/${encodeURIComponent(name)}.png`)
    return { data, slim: false }
  }
  const prof = await fetchJson<{ id: string }>(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`)
  const sess = await fetchJson<{ properties: { name: string; value: string }[] }>(`https://sessionserver.mojang.com/session/minecraft/profile/${prof.id}`)
  const tex = JSON.parse(Buffer.from(sess.properties.find((p) => p.name === 'textures')!.value, 'base64').toString())
  const skin = tex.textures?.SKIN
  if (!skin) throw new Error('У игрока стандартный скин')
  return { data: await fetchImage(skin.url), slim: skin.metadata?.model === 'slim' }
}

function dataUrlToBuffer(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64')
}

export interface SavedSkin {
  file: string
  name: string
  slim: boolean
  data: string
  mtime: number
}

export function listSavedSkins(): SavedSkin[] {
  const dir = dirs.skins()
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => {
      const p = path.join(dir, f)
      return {
        file: f,
        name: f.replace(/(\.slim)?\.png$/, ''),
        slim: f.endsWith('.slim.png'),
        data: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'),
        mtime: fs.statSync(p).mtimeMs
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
}

export function saveSkin(name: string, dataUrl: string, slim: boolean): string {
  const safe = name.replace(/[^\wа-яё -]+/gi, '').trim() || 'skin'
  const file = `${safe}${slim ? '.slim' : ''}.png`
  for (const old of [`${safe}.png`, `${safe}.slim.png`]) fs.rmSync(path.join(dirs.skins(), old), { force: true })
  fs.writeFileSync(path.join(dirs.skins(), file), dataUrlToBuffer(dataUrl))
  return file
}

export function deleteSkin(file: string): void {
  fs.rmSync(path.join(dirs.skins(), path.basename(file)), { force: true })
}

/** Загрузка скина в профиль Minecraft (аккаунт Microsoft). */
export async function uploadSkinMicrosoft(accountId: string, dataUrl: string, slim: boolean): Promise<void> {
  const token = await getMicrosoftToken(accountId)
  const form = new FormData()
  form.append('variant', slim ? 'slim' : 'classic')
  form.append('file', new Blob([dataUrlToBuffer(dataUrl)], { type: 'image/png' }), 'skin.png')
  const res = await fetch('https://api.minecraftservices.com/minecraft/profile/skins', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    body: form
  })
  if (!res.ok) throw new Error(`Mojang отклонил скин: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
  const prof = await getMcProfile(token)
  const active = prof.skins?.find((s) => s.state === 'ACTIVE')?.url
  if (active) updateAccountSkin(accountId, active)
}

export function setOfflineSkinFromData(accountId: string, dataUrl: string, slim: boolean): void {
  setOfflineAccountSkin(accountId, dataUrlToBuffer(dataUrl), slim)
}
