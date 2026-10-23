import type {
  Account,
  CatalogItem,
  CatalogVersion,
  CrashAnalysis,
  Instance,
  JavaInstall,
  JavaRelease,
  LoaderType,
  LoaderVersion,
  McVersion,
  ModInfo,
  RemoteInfo,
  Settings,
  UpdateStatus,
  SyncStatus,
  SyncRemoteInstance,
  ServerStatus,
  ModUpdate,
  WorldInfo,
  ScreenshotInfo
} from '@shared/types'

const call = <T,>(channel: string, ...args: unknown[]): Promise<T> => window.aurora.invoke(channel, ...args) as Promise<T>

export type PublicSettings = Settings & { hasAnthropicKey: boolean; hasCurseforgeKey: boolean }
export type CatalogType = 'modpack' | 'mod' | 'resourcepack' | 'shader'
export interface SavedSkin {
  file: string
  name: string
  slim: boolean
  data: string
  mtime: number
}

export const api = {
  appInfo: () => call<{ version: string; platform: string; arch: string; dataDir: string; totalMem: number }>('app:info'),
  minimize: () => call('win:minimize'),
  maximize: () => call('win:maximize'),
  close: () => call('win:close'),
  openPath: (p: string) => call('shell:openPath', p),
  openUrl: (url: string) => call('shell:openUrl', url),
  openFile: (filters: { name: string; extensions: string[] }[], multi = false) => call<string[]>('dialog:openFile', filters, multi),
  openDir: () => call<string | null>('dialog:openDir'),

  settings: () => call<PublicSettings>('settings:get'),
  updateSettings: (patch: Partial<Settings>) => call<PublicSettings>('settings:update', patch),

  versions: () => call<McVersion[]>('versions:list'),
  loaderVersions: (loader: LoaderType, mc: string) => call<LoaderVersion[]>('loaders:list', loader, mc),

  instances: () => call<Instance[]>('instances:list'),
  instance: (id: string) => call<Instance>('instances:get', id),
  createInstance: (data: Omit<Instance, 'id' | 'createdAt'>) => call<Instance>('instances:create', data),
  updateInstance: (id: string, patch: Partial<Instance>) => call<Instance>('instances:update', id, patch),
  deleteInstance: (id: string) => call('instances:delete', id),
  duplicateInstance: (id: string) => call<Instance>('instances:duplicate', id),
  openInstanceFolder: (id: string, sub?: string) => call('instances:openFolder', id, sub),
  reinstall: (id: string) => call('instances:reinstall', id),
  exportInstance: (id: string) => call<boolean>('instances:export', id),

  launch: (id: string, accountId?: string, server?: string) => call('game:launch', id, accountId, server),
  stop: (id: string) => call('game:stop', id),
  running: () => call<string[]>('game:running'),
  gameLog: (id: string) => call<string[]>('game:log', id),
  askAi: (instanceId: string, analysis: CrashAnalysis, javaInfo: string) => call<string>('crash:ai', instanceId, analysis, javaInfo),

  mods: (id: string) => call<ModInfo[]>('mods:list', id),
  toggleMod: (id: string, file: string, enabled: boolean) => call('mods:toggle', id, file, enabled),
  deleteMod: (id: string, file: string) => call('mods:delete', id, file),
  addModFiles: (id: string, files: string[]) => call('mods:addFiles', id, files),

  search: (
    source: 'modrinth' | 'curseforge',
    opts: { query: string; type: CatalogType; gameVersion?: string; loader?: LoaderType; sort?: string; offset?: number }
  ) => call<{ items: CatalogItem[]; total: number }>('catalog:search', source, opts),
  catalogVersions: (source: 'modrinth' | 'curseforge', projectId: string, mc?: string, loader?: string) =>
    call<CatalogVersion[]>('catalog:versions', source, projectId, mc, loader),
  installPack: (source: 'modrinth' | 'curseforge', projectId: string, versionId?: string) => call<Instance>('catalog:installPack', source, projectId, versionId),
  installProject: (source: 'modrinth' | 'curseforge', instanceId: string, projectId: string, type: Exclude<CatalogType, 'modpack'>, versionId?: string) =>
    call<string[]>('catalog:installProject', source, instanceId, projectId, type, versionId),
  importFile: (file: string) => call<Instance>('catalog:importFile', file),
  installUrl: (url: string, name?: string) => call<Instance>('catalog:installUrl', url, name),

  accounts: () => call<Account[]>('accounts:list'),
  addOffline: (name: string) => call<Account>('accounts:addOffline', name),
  loginMicrosoft: () => call<Account>('accounts:loginMicrosoft'),
  loginYggdrasil: (server: string, user: string, pass: string, name?: string) => call<Account>('accounts:loginYggdrasil', server, user, pass, name),
  removeAccount: (id: string) => call('accounts:remove', id),
  selectAccount: (id: string) => call('accounts:select', id),

  javas: () => call<JavaInstall[]>('java:list'),
  detectJavas: () => call<JavaInstall[]>('java:detect'),
  addJava: (p: string) => call<JavaInstall>('java:add', p),
  removeJava: (p: string) => call('java:remove', p),
  javaReleases: () => call<JavaRelease[]>('java:releases'),
  installJava: (major: number, image: 'jre' | 'jdk') => call<JavaInstall>('java:install', major, image),
  requiredJava: (mc: string) => call<number>('java:required', mc),
  javaHint: (major: number) => call<{ recommendedFor: string; hint: string }>('java:hint', major),

  fetchImage: (url: string) => call<string>('skins:fetch', url),
  skinByName: (name: string, source: 'mojang' | 'ely') => call<{ data: string; slim: boolean }>('skins:byName', name, source),
  savedSkins: () => call<SavedSkin[]>('skins:list'),
  saveSkin: (name: string, data: string, slim: boolean) => call<string>('skins:save', name, data, slim),
  deleteSkin: (file: string) => call('skins:delete', file),
  uploadSkin: (accountId: string, data: string, slim: boolean) => call('skins:uploadMs', accountId, data, slim),
  openSkinsFolder: () => call('skins:openFolder'),

  syncStatus: () => call<SyncStatus>('sync:status'),
  syncGithubStart: () => call<{ userCode: string; uri: string }>('sync:githubStart'),
  syncGithubToken: (token: string) => call<SyncStatus>('sync:githubToken', token),
  syncFolder: () => call<SyncStatus>('sync:folder'),
  syncDisconnect: () => call<SyncStatus>('sync:disconnect'),
  syncList: () => call<SyncRemoteInstance[]>('sync:list'),
  syncPush: (ids?: string[]) => call<{ pushed: number; missing: string[] }>('sync:push', ids),
  syncPull: (id: string) => call<Instance>('sync:pull', id),
  syncRemove: (id: string) => call('sync:remove', id),

  helperSupported: (id: string) => call<boolean>('helper:supported', id),
  pingServer: (address: string) => call<ServerStatus>('servers:ping', address),
  boostFps: (id: string) => call<{ installed: string[]; skipped: string[] }>('features:boostFps', id),
  modUpdates: (id: string) => call<ModUpdate[]>('features:modUpdates', id),
  applyModUpdates: (id: string, updates: ModUpdate[]) => call<number>('features:applyUpdates', id, updates),
  worlds: (id: string) => call<WorldInfo[]>('features:worlds', id),
  backupWorld: (id: string, folder: string) => call<string>('features:backupWorld', id, folder),
  screenshots: (id: string) => call<ScreenshotInfo[]>('features:screenshots', id),
  showItem: (p: string) => call('shell:showItem', p),

  remote: () => call<RemoteInfo>('remote:info'),
  updateStatus: () => call<UpdateStatus>('update:status'),
  checkUpdates: () => call('update:check'),
  installUpdate: () => call('update:install'),

  on: <T,>(channel: string, cb: (payload: T) => void) => window.aurora.on(channel, cb as (p: unknown) => void),
  pathForFile: (f: File) => window.aurora.pathForFile(f),
  showWindow: () => window.aurora.showWindow()
}
