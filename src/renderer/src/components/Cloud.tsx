import { useEffect, useState } from 'react'
import { Cloud, Github, FolderSync, LogOut, UploadCloud, DownloadCloud, Copy, ExternalLink, KeyRound, Trash2, RefreshCw } from 'lucide-react'
import type { SyncRemoteInstance, SyncStatus } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { Modal, Spinner, Switch, InstanceIcon, loaderLabel, timeAgo } from './ui'

/** Кнопка «Скачать из облака» с состоянием загрузки. */
export function PullButton({ item, small }: { item: SyncRemoteInstance; small?: boolean }) {
  const { toast, refreshInstances, refreshCloud } = useStore()
  const [busy, setBusy] = useState(false)
  return (
    <button
      className={`btn ${small ? 'sm' : ''} primary`}
      disabled={busy}
      onClick={async (e) => {
        e.stopPropagation()
        setBusy(true)
        try {
          const inst = await api.syncPull(item.id)
          toast(`Сборка «${inst.name}» перенесена из облака`, 'success')
          await refreshInstances()
          await refreshCloud()
        } catch (err) {
          toast((err as Error).message, 'error')
        } finally {
          setBusy(false)
        }
      }}
    >
      {busy ? <Spinner /> : <DownloadCloud size={14} />} {item.state === 'cloud-newer' ? 'Обновить из облака' : 'Скачать'}
    </button>
  )
}

export function CloudCard() {
  const { sync, cloud, refreshCloud, settings, setSettings, toast } = useStore()
  const [device, setDevice] = useState<{ userCode: string; uri: string } | null>(null)
  const [tokenOpen, setTokenOpen] = useState(false)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refreshCloud()
    return api.on<{ ok: boolean; error?: string; status?: SyncStatus }>('sync:login', (r) => {
      setDevice(null)
      if (r.ok) {
        toast(`Облако подключено: ${r.status?.login}`, 'success')
        void refreshCloud()
      } else toast(r.error || 'Вход не удался', 'error')
    })
  }, [])

  const run = async (fn: () => Promise<unknown>, ok?: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      if (ok) toast(ok, 'success')
      await refreshCloud()
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card pad" style={{ marginTop: 18 }}>
      <h3 className="row">
        <Cloud size={18} /> Облако Aurora — синхронизация сборок
        <span className="grow" />
        {sync?.connected && (
          <button className="btn ghost sm icon" title="Обновить" onClick={() => refreshCloud()}>
            <RefreshCw size={14} />
          </button>
        )}
      </h3>

      {!sync?.connected ? (
        <>
          <div className="muted" style={{ marginBottom: 14 }}>
            Скачали сборку на одном ПК — войдите в облако на другом, и она появится там 1 в 1: та же версия, загрузчик, моды, ресурспаки, шейдеры, настройки и конфиги. Остаётся нажать «Скачать».
          </div>
          <div className="row wrap">
            {sync?.githubLoginAvailable && (
              <button className="btn primary" disabled={busy} onClick={() => run(async () => setDevice(await api.syncGithubStart()))}>
                <Github size={16} /> Войти через GitHub
              </button>
            )}
            <button className={`btn ${sync?.githubLoginAvailable ? '' : 'primary'}`} onClick={() => setTokenOpen(true)}>
              <KeyRound size={16} /> Войти по токену GitHub
            </button>
            <button className="btn" disabled={busy} onClick={() => run(() => api.syncFolder())}>
              <FolderSync size={16} /> Облачная папка (Яндекс Диск, OneDrive…)
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="row" style={{ marginBottom: 12 }}>
            {sync.avatar ? <img src={sync.avatar} className="avatar" style={{ width: 40, height: 40, imageRendering: 'auto' }} /> : <FolderSync size={28} />}
            <div className="grow">
              <b>{sync.provider === 'github' ? `GitHub: ${sync.login}` : 'Облачная папка'}</b>
              <div className="small muted ellipsis">
                {sync.provider === 'folder' ? sync.folder : 'Приватный Gist в вашем аккаунте'} · этот ПК: {sync.device} · {sync.lastSync ? `синхронизировано ${timeAgo(sync.lastSync)}` : 'ещё не синхронизировали'}
              </div>
            </div>
            <button className="btn primary" disabled={busy} onClick={() => run(() => api.syncPush(), 'Все сборки отправлены в облако')}>
              {busy ? <Spinner /> : <UploadCloud size={16} />} Отправить все
            </button>
            <button className="btn ghost" onClick={() => run(() => api.syncDisconnect())}>
              <LogOut size={16} /> Отключить
            </button>
          </div>
          <div className="setting-row">
            <div className="text">
              <b>Автосинхронизация</b>
              <span>Отправлять сборку в облако после каждой игры</span>
            </div>
            <Switch on={!!settings?.syncAuto} onChange={async (v) => setSettings(await api.updateSettings({ syncAuto: v }))} />
          </div>
          <div className="divider" />
          {cloud.length === 0 ? (
            <div className="muted">В облаке пока нет сборок. Нажмите «Отправить все».</div>
          ) : (
            <div className="list">
              {cloud.map((c) => (
                <div key={c.id} className="list-row">
                  <InstanceIcon inst={c} />
                  <div className="grow">
                    <div className="row">
                      <b className="ellipsis">{c.name}</b>
                      {c.state === 'cloud' && <span className="chip accent">только в облаке</span>}
                      {c.state === 'cloud-newer' && <span className="chip warn">в облаке новее</span>}
                      {c.state === 'synced' && <span className="chip ok">синхронизировано</span>}
                    </div>
                    <div className="small muted">
                      {c.mcVersion} · {loaderLabel(c.loader)} · {c.files} файлов · с ПК {c.device} · {timeAgo(c.updatedAt)}
                    </div>
                  </div>
                  {c.state !== 'synced' && <PullButton item={c} small />}
                  <button className="btn ghost sm icon" title="Удалить из облака" onClick={() => run(() => api.syncRemove(c.id), 'Удалено из облака')}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {device && (
        <Modal title="Вход через GitHub" size="narrow" onClose={() => setDevice(null)}>
          <div className="col" style={{ alignItems: 'center', textAlign: 'center', gap: 14 }}>
            <div className="muted">Откройте страницу GitHub и введите этот код:</div>
            <div className="grad-text mono" style={{ fontSize: 34, fontWeight: 800, letterSpacing: 4 }}>{device.userCode}</div>
            <div className="row">
              <button className="btn" onClick={() => navigator.clipboard.writeText(device.userCode)}><Copy size={15} /> Копировать</button>
              <button className="btn primary" onClick={() => api.openUrl(device.uri)}><ExternalLink size={15} /> Открыть GitHub</button>
            </div>
            <div className="row muted small"><Spinner /> Жду подтверждения…</div>
          </div>
        </Modal>
      )}

      {tokenOpen && (
        <Modal
          title="Вход по токену GitHub"
          size="narrow"
          onClose={() => setTokenOpen(false)}
          footer={
            <>
              <button className="btn ghost" onClick={() => setTokenOpen(false)}>Отмена</button>
              <button
                className="btn primary"
                disabled={!token || busy}
                onClick={() => run(async () => { await api.syncGithubToken(token); setTokenOpen(false); setToken('') }, 'Облако подключено')}
              >
                {busy && <Spinner />} Войти
              </button>
            </>
          }
        >
          <div className="col" style={{ gap: 12 }}>
            <div className="muted">
              Бесплатный аккаунт GitHub работает как облако для ваших сборок. Создайте токен с правом <b>gist</b> — сборки будут храниться в приватном Gist, видимом только вам.
            </div>
            <button className="btn" onClick={() => api.openUrl('https://github.com/settings/tokens/new?scopes=gist&description=Aurora%20Launcher%20Sync')}>
              <ExternalLink size={15} /> Создать токен на GitHub
            </button>
            <input className="input mono" type="password" placeholder="ghp_…" value={token} onChange={(e) => setToken(e.target.value)} />
            <div className="small muted">Токен хранится зашифрованным только на этом компьютере.</div>
          </div>
        </Modal>
      )}
    </div>
  )
}
