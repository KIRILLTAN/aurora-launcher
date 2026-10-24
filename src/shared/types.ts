export type LoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'

export interface Instance {
  id: string
  name: string
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  /** id установленной версии (например fabric-loader-0.16.5-1.21.1) */
  versionId?: string
  /** при первом запуске скачать и проверить файлы версии заново */
  cleanInstall?: boolean
  icon?: string
  group?: string
  createdAt: number
  lastPlayed?: number
  playTime?: number
  memoryMax?: number
  memoryMin?: number
  /** пусто = автоматический выбор Java */
  javaPath?: string
  jvmArgs?: string
  gameArgs?: string
  width?: number
  height?: number
  fullscreen?: boolean
  source?: { type: 'modrinth' | 'curseforge' | 'file' | 'github'; projectId?: string; versionId?: string; name?: string }
  /** когда сборка последний раз совпадала с облаком */
  syncedAt?: number
}

export type AccountType = 'microsoft' | 'offline' | 'elyby' | 'yggdrasil'

export interface Account {
  id: string
  type: AccountType
  name: string
  uuid: string
  skinUrl?: string
  capeUrl?: string
  /** адрес сервера для authlib-injector (Ely.by / LittleSkin / свой) */
  server?: string
  serverName?: string
  addedAt: number
}

export interface Settings {
  dataDir: string
  memoryMin: number
  memoryMax: number
  jvmArgs: string
  width: number
  height: number
  afterLaunch: 'keep' | 'hide' | 'close'
  concurrency: number
  showSnapshots: boolean
  curseforgeKey: string
  anthropicKey: string
  aiEnabled: boolean
  accent: 'aurora' | 'emerald' | 'violet' | 'sunset' | 'ice'
  selectedAccount?: string
  selectedInstance?: string
  autoUpdate: boolean
  autoJava: boolean
  msClientId: string
  githubRepo: string
  /** мод-помощник Aurora Helper (F6) */
  helperEnabled: boolean
  /** автоотправка сборки в облако после игры */
  syncAuto: boolean
  githubClientId: string
  servers: SavedServer[]
  /** анимации интерфейса: полные или облегчённые */
  animations: 'full' | 'reduced'
  /** автоподбор памяти по числу модов и ОЗУ */
  memoryAuto: boolean
  /** выполненные разовые миграции настроек */
  migrations?: string[]
  /** профиль JVM: оптимизированный G1, ZGC (Java 21+) или только свои аргументы */
  jvmPreset: 'g1' | 'zgc' | 'custom'
  /** повышенный приоритет процесса игры */
  highPriority: boolean
  /** настройки оверлея-помощника (F6) */
  overlay?: OverlayConfig
  /** свой VPN/прокси */
  proxy?: ProxyConfig
  /** зеркала для Modrinth, CurseForge и Mojang: авто, всегда или никогда */
  mirrors: 'auto' | 'always' | 'never'
}

export interface Task {
  id: string
  title: string
  detail?: string
  progress: number
  status: 'running' | 'done' | 'error' | 'cancelled'
  error?: string
  cancellable?: boolean
}

export interface JavaInstall {
  path: string
  version: string
  major: number
  arch: string
  vendor?: string
  source: 'detected' | 'manual' | 'aurora'
}

export interface JavaRelease {
  major: number
  lts: boolean
  hint: string
  recommendedFor: string
}

export interface McVersion {
  id: string
  type: 'release' | 'snapshot' | 'old_beta' | 'old_alpha'
  releaseTime: string
}

export interface LoaderVersion {
  version: string
  stable: boolean
}

export interface CrashCause {
  severity: 'high' | 'medium' | 'low'
  title: string
  detail: string
  mods?: string[]
  fix?: string
}

export interface CrashAnalysis {
  instanceId: string
  exitCode: number | null
  title: string
  summary: string
  causes: CrashCause[]
  suspectedMods: string[]
  crashReport?: string
  logTail: string
  aiAvailable: boolean
}

export interface ModInfo {
  file: string
  enabled: boolean
  id?: string
  name: string
  version?: string
  description?: string
  loaders: string[]
  size: number
}

export interface CatalogItem {
  source: 'modrinth' | 'curseforge'
  id: string
  slug?: string
  title: string
  description: string
  author?: string
  icon?: string
  downloads: number
  follows?: number
  categories: string[]
  versions?: string[]
  url?: string
}

export interface CatalogVersion {
  id: string
  name: string
  versionNumber: string
  gameVersions: string[]
  loaders: string[]
  date: string
  downloads?: number
  fileName?: string
}

export interface NewsItem {
  title: string
  date: string
  body: string
  image?: string
  url?: string
  tag?: string
}

export interface FeaturedPack {
  title: string
  description: string
  image?: string
  /** modrinth:<projectId> | curseforge:<projectId> | url:<https://...mrpack> */
  ref: string
  tag?: string
}

export interface RemoteInfo {
  news: NewsItem[]
  featured: FeaturedPack[]
  motd?: string
  latestVersion?: string
}

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error' | 'dev'
  version?: string
  progress?: number
  error?: string
}

export interface GameLog {
  instanceId: string
  line: string
  level?: 'info' | 'warn' | 'error'
}

export interface SyncStatus {
  connected: boolean
  provider?: 'github' | 'folder'
  login?: string
  avatar?: string
  folder?: string
  lastSync?: number
  device: string
  githubLoginAvailable: boolean
}

export interface SyncRemoteInstance {
  id: string
  name: string
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
  icon?: string
  updatedAt: number
  device: string
  files: number
  state?: 'cloud' | 'synced' | 'cloud-newer'
}

export interface SavedServer {
  name: string
  address: string
}

export interface ServerStatus {
  online: boolean
  latency?: number
  players?: number
  maxPlayers?: number
  version?: string
  motd?: string
  favicon?: string
  error?: string
}

export interface ModUpdate {
  file: string
  newFile: string
  version: string
  url: string
  sha1: string
}

export interface WorldInfo {
  folder: string
  lastPlayed: number
  size: number
  icon?: string
}

export interface ScreenshotInfo {
  file: string
  path: string
  time: number
  thumb: string
}

export interface ImportPreview {
  file: string
  format: 'prism' | 'curseforge-app' | 'atlauncher' | 'minecraft' | 'mrpack' | 'curseforge-pack'
  formatLabel: string
  name: string
  mcVersion?: string
  loader: LoaderType
  loaderVersion?: string
  playTime?: number
  memoryMax?: number
  jvmArgs?: string
  mods: number
  worlds: number
  sizeMb: number
}

export interface OverlayConfig {
  loot: boolean
  worldIcons: boolean
  radius: number
  arrows: boolean
  coords: boolean
  fps: boolean
  clock: boolean
  armor: boolean
  offhand: boolean
  rightSide: boolean
  maxLines: number
  /** полноэкранный режим игры заменяется на окно без рамки, чтобы оверлей был виден */
  borderless: boolean
  /** автоподмена: новый стак в руку, тотем в левую руку, запасная броня */
  autoRefill: boolean
  /** аварийный тотем: при здоровье ≤ totemHp тотем из инвентаря ставится в левую руку */
  emergencyTotem: boolean
  totemHp: number
  /** при TNT рядом — тотем и в правую руку */
  totemBoth: boolean
}

export interface ProxyConfig {
  enabled: boolean
  type: 'http' | 'socks5'
  host: string
  port: number
  user?: string
  pass?: string
  /** передавать прокси игре (вход, скины, Realms) */
  game: boolean
}
