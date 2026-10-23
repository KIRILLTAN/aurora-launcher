import fs from 'fs'
import http from 'http'
import path from 'path'
import crypto from 'crypto'
import { app } from 'electron'
import type { Account } from '@shared/types'
import { readJson, writeJson, ensureDir, exists } from '../util/store'

/*
 * Скины для оффлайн-аккаунтов. Лаунчер поднимает на 127.0.0.1 маленький
 * сервер в формате Yggdrasil, а игра подключается к нему через authlib-injector
 * и берёт скин оттуда. Текстуры подписываются своим RSA-ключом, как у настоящих
 * скин-серверов (LittleSkin, Ely.by), поэтому игра их принимает.
 */

interface SkinEntry {
  uuid: string
  name: string
  slim: boolean
  file: string
}

const dir = (): string => ensureDir(path.join(app.getPath('userData'), 'offline-skins'))
const indexFile = (): string => path.join(dir(), 'index.json')

function loadIndex(): Record<string, SkinEntry> {
  return readJson<Record<string, SkinEntry>>(indexFile(), {})
}

export function setOfflineSkin(acc: Account, png: Buffer, slim: boolean): string {
  const file = path.join(dir(), `${acc.uuid}.png`)
  fs.writeFileSync(file, png)
  const idx = loadIndex()
  idx[acc.uuid] = { uuid: acc.uuid, name: acc.name, slim, file }
  writeJson(indexFile(), idx)
  return file
}

export function removeOfflineSkin(uuid: string): void {
  const idx = loadIndex()
  delete idx[uuid]
  writeJson(indexFile(), idx)
}

export function hasOfflineSkin(uuid: string): boolean {
  const e = loadIndex()[uuid]
  return !!e && exists(e.file)
}

// ---------------- Ключи подписи ----------------

let keys: { privateKey: string; publicKey: string } | null = null
function keyPair(): { privateKey: string; publicKey: string } {
  if (keys) return keys
  const file = path.join(dir(), 'signing-key.json')
  keys = readJson<{ privateKey: string; publicKey: string } | null>(file, null)
  if (!keys) {
    const k = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 })
    keys = {
      privateKey: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey: k.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    }
    writeJson(file, keys)
  }
  return keys
}

function sign(value: string): string {
  return crypto.sign('sha1', Buffer.from(value), keyPair().privateKey).toString('base64')
}

// ---------------- HTTP-сервер ----------------

let server: http.Server | null = null
let base = ''

function json(res: http.ServerResponse, code: number, body?: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

function profile(e: SkinEntry, signed: boolean): unknown {
  const textures = {
    timestamp: Date.now(),
    profileId: e.uuid,
    profileName: e.name,
    textures: { SKIN: { url: `${base}/textures/${e.uuid}`, ...(e.slim ? { metadata: { model: 'slim' } } : {}) } }
  }
  const value = Buffer.from(JSON.stringify(textures)).toString('base64')
  return { id: e.uuid, name: e.name, properties: [{ name: 'textures', value, ...(signed ? { signature: sign(value) } : {}) }] }
}

export let skinServerHits: string[] = []

function handle(req: http.IncomingMessage, res: http.ServerResponse): void {
  skinServerHits = [...skinServerHits.slice(-50), `${req.method} ${req.url}`]
  const url = new URL(req.url || '/', base)
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const idx = loadIndex()
  const byName = (n: string): SkinEntry | undefined => Object.values(idx).find((e) => e.name.toLowerCase() === n.toLowerCase())

  if (p === '/') {
    return json(res, 200, {
      meta: { serverName: 'Aurora Launcher — оффлайн-скины', implementationName: 'aurora-launcher', implementationVersion: app.getVersion(), 'feature.non_email_login': true },
      skinDomains: ['127.0.0.1', 'localhost'],
      signaturePublickey: keyPair().publicKey
    })
  }
  let m = /^\/sessionserver\/session\/minecraft\/profile\/([0-9a-f-]{32,36})$/i.exec(p)
  if (m) {
    const e = idx[m[1].replace(/-/g, '')]
    return e ? json(res, 200, profile(e, true)) : json(res, 204)
  }
  m = /^\/textures\/([0-9a-f]{32})$/i.exec(p)
  if (m) {
    const e = idx[m[1]]
    if (!e || !exists(e.file)) return json(res, 404)
    res.writeHead(200, { 'Content-Type': 'image/png' })
    return void fs.createReadStream(e.file).pipe(res)
  }
  m = /^\/api\/users\/profiles\/minecraft\/(.+)$/.exec(p)
  if (m) {
    const e = byName(decodeURIComponent(m[1]))
    return e ? json(res, 200, { id: e.uuid, name: e.name }) : json(res, 204)
  }
  if (p === '/api/profiles/minecraft' && req.method === 'POST') {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let names: string[] = []
      try {
        names = JSON.parse(body)
      } catch {
        /* пусто */
      }
      json(res, 200, names.map(byName).filter(Boolean).map((e) => ({ id: e!.uuid, name: e!.name })))
    })
    return
  }
  if (p === '/minecraftservices/player/attributes') {
    return json(res, 200, {
      privileges: { onlineChat: { enabled: true }, multiplayerServer: { enabled: true }, multiplayerRealms: { enabled: false }, telemetry: { enabled: false } },
      profanityFilterPreferences: { profanityFilterOn: false }
    })
  }
  if (p.startsWith('/sessionserver/session/minecraft/join') || p.startsWith('/sessionserver/session/minecraft/hasJoined')) return json(res, 204)
  json(res, 404, { error: 'Not Found' })
}

/** Адрес локального скин-сервера (запускается при первом обращении). */
export function offlineSkinServer(): Promise<string> {
  if (server) return Promise.resolve(base)
  return new Promise((resolve, reject) => {
    const s = http.createServer(handle)
    s.on('error', reject)
    s.listen(0, '127.0.0.1', () => {
      server = s
      base = `http://127.0.0.1:${(s.address() as { port: number }).port}`
      keyPair()
      resolve(base)
    })
  })
}
