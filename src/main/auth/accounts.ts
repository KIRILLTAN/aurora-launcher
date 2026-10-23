import { app, BrowserWindow, safeStorage, session } from 'electron'
import path from 'path'
import crypto from 'crypto'
import type { Account } from '@shared/types'
import { readJson, writeJson, uid } from '../util/store'
import { fetchJson, httpFetch, USER_AGENT, HttpError } from '../util/net'
import { getSettings, updateSettings } from '../settings'
import { hasOfflineSkin, offlineSkinServer, setOfflineSkin, removeOfflineSkin } from './offlineSkins'

interface Secret {
  msRefresh?: string
  mcToken?: string
  mcExpires?: number
  accessToken?: string
  clientToken?: string
}

interface StoredAccount extends Account {
  secret: string
}

const file = (): string => path.join(app.getPath('userData'), 'accounts.json')

function seal(s: Secret): string {
  const json = JSON.stringify(s)
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(json).toString('base64')
  return 'raw:' + Buffer.from(json).toString('base64')
}
function unseal(v: string): Secret {
  try {
    if (v.startsWith('enc:')) return JSON.parse(safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')))
    if (v.startsWith('raw:')) return JSON.parse(Buffer.from(v.slice(4), 'base64').toString())
  } catch {
    /* повреждено — потребуется повторный вход */
  }
  return {}
}

function loadAll(): StoredAccount[] {
  return readJson<StoredAccount[]>(file(), [])
}
function saveAll(list: StoredAccount[]): void {
  writeJson(file(), list)
}
function strip(a: StoredAccount): Account {
  const { secret: _s, ...rest } = a
  return rest
}

export function listAccounts(): Account[] {
  return loadAll().map(strip)
}

function upsert(acc: Account, secret: Secret): Account {
  const list = loadAll()
  const idx = list.findIndex((a) => a.type === acc.type && a.uuid === acc.uuid && a.server === acc.server)
  const stored: StoredAccount = { ...acc, secret: seal(secret) }
  if (idx >= 0) {
    stored.id = list[idx].id
    list[idx] = stored
  } else list.push(stored)
  saveAll(list)
  updateSettings({ selectedAccount: stored.id })
  return strip(stored)
}

export function removeAccount(id: string): void {
  const acc = loadAll().find((a) => a.id === id)
  if (acc?.type === 'offline' && !loadAll().some((a) => a.id !== id && a.uuid === acc.uuid)) removeOfflineSkin(acc.uuid)
  saveAll(loadAll().filter((a) => a.id !== id))
  if (getSettings().selectedAccount === id) updateSettings({ selectedAccount: loadAll()[0]?.id })
}

// ---------------- Оффлайн ----------------

/** UUID как у Java UUID.nameUUIDFromBytes("OfflinePlayer:" + name) */
export function offlineUuid(name: string): string {
  const h = crypto.createHash('md5').update('OfflinePlayer:' + name).digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  return h.toString('hex')
}

export function addOffline(name: string): Account {
  if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) throw new Error('Ник: 3–16 символов, латиница, цифры и _')
  return upsert({ id: uid(), type: 'offline', name, uuid: offlineUuid(name), addedAt: Date.now() }, {})
}

// ---------------- Microsoft ----------------

const LIVE_CLIENT = '00000000402b5328'
const LIVE_REDIRECT = 'https://login.live.com/oauth20_desktop.srf'
const LIVE_SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL'

function oauthConfig(): { authUrl: string; tokenUrl: string; clientId: string; redirect: string; scope: string; rps: (t: string) => string } {
  const custom = getSettings().msClientId.trim()
  if (custom) {
    return {
      authUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize',
      tokenUrl: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
      clientId: custom,
      redirect: 'https://login.microsoftonline.com/common/oauth2/nativeclient',
      scope: 'XboxLive.signin offline_access',
      rps: (t) => 'd=' + t
    }
  }
  return {
    authUrl: 'https://login.live.com/oauth20_authorize.srf',
    tokenUrl: 'https://login.live.com/oauth20_token.srf',
    clientId: LIVE_CLIENT,
    redirect: LIVE_REDIRECT,
    scope: LIVE_SCOPE,
    rps: (t) => t
  }
}

function askMicrosoftCode(parent?: BrowserWindow): Promise<string> {
  const cfg = oauthConfig()
  const url =
    `${cfg.authUrl}?client_id=${cfg.clientId}&response_type=code&prompt=select_account` +
    `&scope=${encodeURIComponent(cfg.scope)}&redirect_uri=${encodeURIComponent(cfg.redirect)}`
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      width: 520,
      height: 700,
      parent,
      modal: !!parent,
      title: 'Вход в Microsoft',
      autoHideMenuBar: true,
      backgroundColor: '#0b1026',
      webPreferences: { session: session.fromPartition('persist:aurora-ms'), contextIsolation: true, nodeIntegration: false }
    })
    let finished = false
    const check = (target: string): void => {
      if (!target.startsWith(cfg.redirect)) return
      const u = new URL(target)
      const code = u.searchParams.get('code')
      const err = u.searchParams.get('error_description') || u.searchParams.get('error')
      finished = true
      win.close()
      if (code) resolve(code)
      else reject(new Error(err || 'Вход отменён'))
    }
    win.webContents.on('will-redirect', (_e, target) => check(target))
    win.webContents.on('will-navigate', (_e, target) => check(target))
    win.webContents.on('did-navigate', (_e, target) => check(target))
    win.on('closed', () => {
      if (!finished) reject(new Error('Окно входа закрыто'))
    })
    win.loadURL(url)
  })
}

async function msToken(params: Record<string, string>): Promise<{ access_token: string; refresh_token: string }> {
  const cfg = oauthConfig()
  const body = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.redirect, scope: cfg.scope, ...params })
  return fetchJson(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
}

const XERR: Record<string, string> = {
  '2148916233': 'У этого аккаунта Microsoft нет профиля Xbox. Зайдите на xbox.com и создайте его.',
  '2148916235': 'Xbox Live недоступен в вашей стране.',
  '2148916236': 'Нужна верификация возраста на xbox.com.',
  '2148916237': 'Нужна верификация возраста на xbox.com.',
  '2148916238': 'Детский аккаунт: добавьте его в семейную группу Microsoft.'
}

async function minecraftFromMs(msAccess: string): Promise<{ token: string; expires: number; profile: McProfile }> {
  const cfg = oauthConfig()
  const xbl = await fetchJson<{ Token: string; DisplayClaims: { xui: { uhs: string }[] } }>(
    'https://user.auth.xboxlive.com/user/authenticate',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: cfg.rps(msAccess) },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT'
      })
    }
  )
  const xstsRes = await httpFetch('https://xsts.auth.xboxlive.com/xsts/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({
      Properties: { SandboxId: 'RETAIL', UserTokens: [xbl.Token] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    })
  })
  const xsts = (await xstsRes.json()) as { Token: string; DisplayClaims: { xui: { uhs: string }[] }; XErr?: number }
  if (!xstsRes.ok) throw new Error(XERR[String(xsts.XErr)] || `Ошибка Xbox (XSTS ${xstsRes.status})`)
  const uhs = xsts.DisplayClaims.xui[0].uhs
  const mc = await fetchJson<{ access_token: string; expires_in: number }>(
    'https://api.minecraftservices.com/authentication/login_with_xbox',
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identityToken: `XBL3.0 x=${uhs};${xsts.Token}` }) }
  )
  let profile: McProfile
  try {
    profile = await getMcProfile(mc.access_token)
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) throw new Error('На этом аккаунте не куплен Minecraft: Java Edition.')
    throw e
  }
  return { token: mc.access_token, expires: Date.now() + mc.expires_in * 1000 - 60_000, profile }
}

interface McProfile {
  id: string
  name: string
  skins?: { url: string; state: string; variant: string }[]
  capes?: { url: string; state: string }[]
}

export function getMcProfile(token: string): Promise<McProfile> {
  return fetchJson<McProfile>('https://api.minecraftservices.com/minecraft/profile', { headers: { Authorization: `Bearer ${token}` } })
}

export async function loginMicrosoft(parent?: BrowserWindow): Promise<Account> {
  const code = await askMicrosoftCode(parent)
  const ms = await msToken({ code, grant_type: 'authorization_code' })
  const mc = await minecraftFromMs(ms.access_token)
  return upsert(
    {
      id: uid(),
      type: 'microsoft',
      name: mc.profile.name,
      uuid: mc.profile.id,
      skinUrl: mc.profile.skins?.find((s) => s.state === 'ACTIVE')?.url,
      capeUrl: mc.profile.capes?.find((c) => c.state === 'ACTIVE')?.url,
      addedAt: Date.now()
    },
    { msRefresh: ms.refresh_token, mcToken: mc.token, mcExpires: mc.expires }
  )
}

// ---------------- Ely.by и любые Yggdrasil-серверы (authlib-injector) ----------------

export const ELY_SERVER = 'https://authserver.ely.by/api/authlib-injector'

function yggBase(server: string): string {
  return server === 'ely.by' || server === ELY_SERVER ? 'https://authserver.ely.by' : server.replace(/\/$/, '') + '/authserver'
}

interface YggAuth {
  accessToken: string
  clientToken: string
  selectedProfile?: { id: string; name: string }
  availableProfiles?: { id: string; name: string }[]
}

export async function loginYggdrasil(server: string, username: string, password: string, serverName?: string): Promise<Account> {
  const clientToken = crypto.randomUUID().replace(/-/g, '')
  const base = yggBase(server)
  const res = await httpFetch(`${base}/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify({ agent: { name: 'Minecraft', version: 1 }, username, password, clientToken, requestUser: true })
  })
  const data = (await res.json().catch(() => ({}))) as YggAuth & { errorMessage?: string; error?: string }
  if (!res.ok) {
    const msg = data.errorMessage || data.error || `HTTP ${res.status}`
    if (/two factor|totp|2fa/i.test(msg)) throw new Error('Включена двухфакторная защита: введите пароль в виде «пароль:код»')
    throw new Error(msg === 'Invalid credentials. Invalid username or password.' ? 'Неверный логин или пароль' : msg)
  }
  const prof = data.selectedProfile || data.availableProfiles?.[0]
  if (!prof) throw new Error('На аккаунте нет игрового профиля')
  const isEly = server === 'ely.by' || server === ELY_SERVER
  return upsert(
    {
      id: uid(),
      type: isEly ? 'elyby' : 'yggdrasil',
      name: prof.name,
      uuid: prof.id,
      server: isEly ? ELY_SERVER : server.replace(/\/$/, ''),
      serverName: isEly ? 'Ely.by' : serverName || new URL(server).host,
      skinUrl: isEly ? `http://skinsystem.ely.by/skins/${prof.name}.png` : undefined,
      addedAt: Date.now()
    },
    { accessToken: data.accessToken, clientToken: data.clientToken || clientToken }
  )
}

// ---------------- Данные для запуска ----------------

export interface LaunchAuth {
  account: Account
  name: string
  uuid: string
  accessToken: string
  userType: string
  xuid: string
  /** адрес для authlib-injector */
  injector?: string
}

export async function getLaunchAuth(id: string): Promise<LaunchAuth> {
  const list = loadAll()
  const stored = list.find((a) => a.id === id)
  if (!stored) throw new Error('Аккаунт не найден — добавьте его во вкладке «Аккаунты»')
  const secret = unseal(stored.secret)
  const acc = strip(stored)

  if (stored.type === 'offline') {
    // свой скин у оффлайн-аккаунта — через локальный скин-сервер и authlib-injector
    if (hasOfflineSkin(acc.uuid)) {
      return { account: acc, name: acc.name, uuid: acc.uuid, accessToken: '0', userType: 'mojang', xuid: '0', injector: await offlineSkinServer() }
    }
    return { account: acc, name: acc.name, uuid: acc.uuid, accessToken: '0', userType: 'legacy', xuid: '0' }
  }

  if (stored.type === 'microsoft') {
    if (!secret.mcToken || !secret.mcExpires || secret.mcExpires < Date.now()) {
      if (!secret.msRefresh) throw new Error('Сессия Microsoft истекла — войдите заново')
      const ms = await msToken({ refresh_token: secret.msRefresh, grant_type: 'refresh_token' })
      const mc = await minecraftFromMs(ms.access_token)
      secret.msRefresh = ms.refresh_token
      secret.mcToken = mc.token
      secret.mcExpires = mc.expires
      stored.name = mc.profile.name
      stored.skinUrl = mc.profile.skins?.find((s) => s.state === 'ACTIVE')?.url
      stored.secret = seal(secret)
      saveAll(list)
    }
    return { account: strip(stored), name: stored.name, uuid: stored.uuid, accessToken: secret.mcToken!, userType: 'msa', xuid: '0' }
  }

  // Yggdrasil: проверяем токен и обновляем при необходимости
  const base = yggBase(stored.server || ELY_SERVER)
  const ok = await httpFetch(`${base}/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken: secret.accessToken, clientToken: secret.clientToken })
  })
    .then((r) => r.ok)
    .catch(() => true) // нет сети — пробуем со старым токеном
  if (!ok) {
    const r = await httpFetch(`${base}/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: secret.accessToken, clientToken: secret.clientToken, requestUser: true })
    })
    if (!r.ok) throw new Error(`Сессия ${stored.serverName || 'Ely.by'} истекла — войдите заново`)
    const d = (await r.json()) as YggAuth
    secret.accessToken = d.accessToken
    stored.secret = seal(secret)
    saveAll(list)
  }
  return {
    account: acc,
    name: acc.name,
    uuid: acc.uuid,
    accessToken: secret.accessToken!,
    userType: 'mojang',
    xuid: '0',
    injector: stored.type === 'elyby' ? 'ely.by' : stored.server
  }
}

/** Токен Minecraft-сервисов для загрузки скина в аккаунт Microsoft. */
export async function getMicrosoftToken(id: string): Promise<string> {
  const auth = await getLaunchAuth(id)
  if (auth.account.type !== 'microsoft') throw new Error('Загрузка скина доступна только для аккаунтов Microsoft')
  return auth.accessToken
}

/** Скин для оффлайн-аккаунта: хранится у лаунчера и раздаётся игре локальным скин-сервером. */
export function setOfflineAccountSkin(id: string, png: Buffer, slim: boolean): void {
  const list = loadAll()
  const a = list.find((x) => x.id === id)
  if (!a || a.type !== 'offline') throw new Error('Это не оффлайн-аккаунт')
  // метка времени в адресе — чтобы интерфейс не показывал старый скин из кэша
  a.skinUrl = `${setOfflineSkin(strip(a), png, slim)}#${Date.now()}`
  saveAll(list)
}

export function updateAccountSkin(id: string, skinUrl: string): void {
  const list = loadAll()
  const a = list.find((x) => x.id === id)
  if (a) {
    a.skinUrl = skinUrl
    saveAll(list)
  }
}
