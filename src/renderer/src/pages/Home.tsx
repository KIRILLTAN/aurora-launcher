import { useEffect, useState } from 'react'
import { Play, Square, Plus, Newspaper, Sparkles, Clock, Github, FolderOpen, Settings2 } from 'lucide-react'
import type { FeaturedPack, Instance, RemoteInfo } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { InstanceIcon, loaderLabel, fmtPlaytime, timeAgo, Markdown, Spinner, LoaderIcon } from '../components/ui'
import { ServersCard } from "../components/Servers"

export default function HomePage() {
  const { instances, settings, running, play, go, setCreateOpen, toast, setSettings } = useStore()
  const [remote, setRemote] = useState<RemoteInfo | null>(null)
  const [loadingRemote, setLoadingRemote] = useState(true)
  const selected: Instance | undefined = instances.find((i) => i.id === settings?.selectedInstance) || instances[0]
  const isRunning = selected && running.includes(selected.id)

  useEffect(() => {
    api.remote().then(setRemote).catch(() => undefined).finally(() => setLoadingRemote(false))
  }, [])

  const select = async (id: string): Promise<void> => setSettings(await api.updateSettings({ selectedInstance: id }))

  const installFeatured = async (p: FeaturedPack): Promise<void> => {
    const [kind, ...rest] = p.ref.split(':')
    const ref = rest.join(':')
    try {
      toast(`Устанавливаю «${p.title}»…`)
      const inst =
        kind === 'url' ? await api.installUrl(ref, p.title) : await api.installPack(kind === 'curseforge' ? 'curseforge' : 'modrinth', ref)
      toast(`Сборка «${inst.name}» готова!`, 'success')
      await select(inst.id)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  return (
    <div className="page">
      <section className="hero">
        <div className="ribbons">
          <span />
          <span />
          <span />
        </div>
        {remote?.motd && <div className="motd">{remote.motd}</div>}
        {instances.length > 0 && (
          <div className="motd" style={{ top: remote?.motd ? 44 : 22 }}>
            Всего наиграно: <b>{fmtPlaytime(instances.reduce((s, i) => s + (i.playTime || 0), 0))}</b> · сборок: <b>{instances.length}</b>
          </div>
        )}
        {selected ? (
          <>
            <div className="kicker">{isRunning ? 'Сейчас в игре' : 'Готово к игре'}</div>
            <div className="row" style={{ gap: 16, alignItems: 'center' }}>
              <InstanceIcon inst={selected} size="lg" />
              <h1>{selected.name}</h1>
            </div>
            <div className="meta">
              <span className="chip accent">Minecraft {selected.mcVersion}</span>
              <span className="chip"><LoaderIcon loader={selected.loader} size={13} /> {loaderLabel(selected.loader)} {selected.loaderVersion || ''}</span>
              <span className="chip">
                <Clock size={11} /> {fmtPlaytime(selected.playTime)}
              </span>
              <span className="chip">{timeAgo(selected.lastPlayed)}</span>
            </div>
            <div className="actions">
              {isRunning ? (
                <button className="btn play-btn stop" onClick={() => api.stop(selected.id)}>
                  <Square size={20} fill="currentColor" /> Закрыть игру
                </button>
              ) : (
                <button className="btn primary play-btn" onClick={() => play(selected.id)}>
                  <Play size={22} fill="currentColor" /> Играть
                </button>
              )}
              <button className="btn lg" onClick={() => go('instance', selected.id)}>
                <Settings2 size={18} /> Управление
              </button>
              <button className="btn lg icon" title="Открыть папку" onClick={() => api.openInstanceFolder(selected.id)}>
                <FolderOpen size={18} />
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="kicker">Добро пожаловать</div>
            <h1>
              Aurora <span className="grad-text">Launcher</span>
            </h1>
            <p className="muted" style={{ marginTop: 0, marginBottom: 22, maxWidth: 520 }}>
              Создайте первую сборку: любая версия Minecraft, Fabric, Forge, NeoForge или Quilt — или скачайте готовый модпак с Modrinth и CurseForge.
            </p>
            <div className="actions">
              <button className="btn primary lg" onClick={() => setCreateOpen(true)}>
                <Plus size={18} /> Создать сборку
              </button>
              <button className="btn lg" onClick={() => go('catalog')}>
                <Sparkles size={18} /> Каталог модпаков
              </button>
            </div>
          </>
        )}
      </section>

      {instances.length > 0 && (
        <div className="quick-row" style={{ marginTop: 18 }}>
          {instances.slice(0, 8).map((i) => (
            <div key={i.id} className={`card quick ${selected?.id === i.id ? 'selected' : ''}`} onClick={() => select(i.id)} onDoubleClick={() => play(i.id)}>
              <InstanceIcon inst={i} />
              <div className="grow">
                <div className="ellipsis" style={{ fontWeight: 600 }}>{i.name}</div>
                <div className="small muted">
                  {i.mcVersion} · {loaderLabel(i.loader)}
                  {running.includes(i.id) && <span style={{ color: 'var(--ok)' }}> · в игре</span>}
                </div>
              </div>
            </div>
          ))}
          <div className="card quick" onClick={() => setCreateOpen(true)} style={{ justifyContent: 'center', color: 'var(--muted)' }}>
            <Plus size={18} /> Новая сборка
          </div>
        </div>
      )}

      <div className="home-grid">
        <div className="card pad">
          <h3 className="row">
            <Newspaper size={17} /> Новости
            <span className="grow" />
            <button className="btn ghost sm" onClick={() => api.openUrl(`https://github.com/${settings?.githubRepo || 'KIRILLTAN/aurora-launcher'}`)}>
              <Github size={14} /> GitHub
            </button>
          </h3>
          {loadingRemote && <div className="row muted"><Spinner /> Загрузка с GitHub…</div>}
          {!loadingRemote && !remote?.news.length && <div className="muted">Новостей пока нет — они берутся из файла remote/news.json в репозитории.</div>}
          {remote?.news.map((n, i) => (
            <div key={i} className="news-item" onClick={() => n.url && api.openUrl(n.url)} style={{ cursor: n.url ? 'pointer' : 'default' }}>
              {n.image && <img src={n.image} />}
              <div className="grow">
                <div className="row">
                  <h4>{n.title}</h4>
                  {n.tag && <span className="chip accent">{n.tag}</span>}
                </div>
                <div className="date">{n.date}</div>
                <Markdown text={n.body} />
              </div>
            </div>
          ))}
        </div>
        <div className="card pad">
          <h3 className="row">
            <Sparkles size={17} /> Сборки от KIRILLTAN
          </h3>
          {!loadingRemote && !remote?.featured.length && <div className="muted">Здесь появятся рекомендованные сборки из remote/featured.json.</div>}
          {remote?.featured.map((p, i) => (
            <div key={i} className="featured" onClick={() => installFeatured(p)}>
              {p.image ? <img src={p.image} /> : <div className="ph" />}
              <div className="grow">
                <div className="row">
                  <b className="ellipsis">{p.title}</b>
                  {p.tag && <span className="chip">{p.tag}</span>}
                </div>
                <div className="small muted">{p.description}</div>
              </div>
              <button className="btn sm primary">Установить</button>
            </div>
          ))}
        </div>
      </div>
      <ServersCard instanceId={selected?.id} />
    </div>
  )
}
