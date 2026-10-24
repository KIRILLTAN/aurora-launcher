import { app } from 'electron'
import path from 'path'
import type { Settings } from '@shared/types'
import { readJson, writeJson, ensureDir } from './util/store'

/** Аргументы по умолчанию из версии 1.0 — теперь их заменяет оптимизированный профиль. */
const LEGACY_JVM =
  '-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20 -XX:MaxGCPauseMillis=50 -XX:G1HeapRegionSize=32M'

function defaults(): Settings {
  return {
    dataDir: path.join(app.getPath('appData'), '.aurora'),
    memoryMin: 1024,
    memoryMax: 4096,
    jvmArgs: '',
    width: 1280,
    height: 720,
    afterLaunch: 'hide',
    concurrency: 16,
    showSnapshots: true,
    curseforgeKey: '',
    anthropicKey: '',
    aiEnabled: true,
    accent: 'aurora',
    autoUpdate: true,
    autoJava: true,
    msClientId: '',
    githubRepo: 'KIRILLTAN/aurora-launcher',
    helperEnabled: false,
    syncAuto: true,
    githubClientId: '',
    servers: [],
    animations: 'full',
    memoryAuto: false,
    jvmPreset: 'g1',
    highPriority: true,
    mirrors: 'auto'
  }
}

const file = (): string => path.join(app.getPath('userData'), 'settings.json')
let cache: Settings | null = null

export function getSettings(): Settings {
  if (!cache) {
    cache = { ...defaults(), ...readJson<Partial<Settings>>(file(), {}) }
    if (cache.jvmArgs === LEGACY_JVM) cache.jvmArgs = ''
    // разовые изменения значений по умолчанию для уже сохранённых настроек
    const done = cache.migrations || []
    if (!done.includes('memory-auto-off')) {
      cache.memoryAuto = false
      cache.migrations = [...done, 'memory-auto-off']
      writeJson(file(), cache)
    }
  }
  return cache
}

export function updateSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch }
  writeJson(file(), cache)
  return cache
}

/** Публичные настройки для интерфейса: секреты не отдаём целиком. */
export function publicSettings(): Settings & { hasAnthropicKey: boolean; hasCurseforgeKey: boolean } {
  const s = getSettings()
  return {
    ...s,
    anthropicKey: s.anthropicKey ? '••••' + s.anthropicKey.slice(-4) : '',
    curseforgeKey: s.curseforgeKey ? '••••' + s.curseforgeKey.slice(-4) : '',
    proxy: s.proxy ? { ...s.proxy, pass: s.proxy.pass ? '••••' : '' } : undefined,
    hasAnthropicKey: !!s.anthropicKey,
    hasCurseforgeKey: !!s.curseforgeKey
  }
}

export const dirs = {
  root: () => ensureDir(getSettings().dataDir),
  libraries: () => ensureDir(path.join(getSettings().dataDir, 'libraries')),
  assets: () => ensureDir(path.join(getSettings().dataDir, 'assets')),
  versions: () => ensureDir(path.join(getSettings().dataDir, 'versions')),
  instances: () => ensureDir(path.join(getSettings().dataDir, 'instances')),
  java: () => ensureDir(path.join(getSettings().dataDir, 'java')),
  cache: () => ensureDir(path.join(getSettings().dataDir, 'cache')),
  skins: () => ensureDir(path.join(getSettings().dataDir, 'skins'))
}
