import { useMemo, useState } from 'react'
import { Plus, Play, Square, Search, Boxes, Upload, Cloud, FolderInput } from 'lucide-react'
import type { LoaderType } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { InstanceIcon, loaderLabel, timeAgo, LOADERS, LoaderIcon } from '../components/ui'
import { PullButton } from '../components/Cloud'
import { beginImport } from '../dialogs/Import'

export default function LibraryPage() {
  const { instances, running, play, go, setCreateOpen, toast, cloud } = useStore()
  const cloudOnly = cloud.filter((c) => c.state === 'cloud')
  const [q, setQ] = useState('')
  const [loader, setLoader] = useState<LoaderType | 'all'>('all')
  const [over, setOver] = useState(false)

  const list = useMemo(
    () => instances.filter((i) => (loader === 'all' || i.loader === loader) && i.name.toLowerCase().includes(q.toLowerCase())),
    [instances, q, loader]
  )

  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setOver(false)
    for (const f of Array.from(e.dataTransfer.files)) await beginImport(api.pathForFile(f))
  }

  return (
    <div className="page" onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="page-header">
        <div>
          <h1>Мои сборки</h1>
          <p>Перетащите сюда архив или папку сборки — из Prism, MultiMC, CurseForge, TLauncher, .mrpack</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={async () => {
            const [file] = await api.openFile([{ name: 'Сборки', extensions: ['zip', 'mrpack'] }])
            if (file) beginImport(file)
          }}>
            <Upload size={16} /> Импорт архива
          </button>
          <button className="btn" onClick={async () => {
            const dir = await api.openDir()
            if (dir) beginImport(dir)
          }}>
            <FolderInput size={16} /> Импорт папки
          </button>
          <button className="btn primary" onClick={() => setCreateOpen(true)}>
            <Plus size={16} /> Создать сборку
          </button>
        </div>
      </div>

      <div className="row" style={{ marginBottom: 18 }}>
        <div className="search grow" style={{ maxWidth: 360 }}>
          <Search size={16} />
          <input className="input" placeholder="Поиск сборки" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg">
          <button className={loader === 'all' ? 'active' : ''} onClick={() => setLoader('all')}>Все</button>
          {LOADERS.map((l) => (
            <button key={l.id} className={loader === l.id ? 'active' : ''} onClick={() => setLoader(l.id)} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <LoaderIcon loader={l.id} size={15} />
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {over && <div className="drop-zone over" style={{ marginBottom: 16 }}>Отпустите архив или папку для импорта сборки</div>}

      {instances.length === 0 ? (
        <div className="empty">
          <Boxes size={54} />
          <h3>Сборок пока нет</h3>
          <div>Создайте свою или установите готовую из каталога</div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> Создать</button>
            <button className="btn" onClick={() => go('catalog')}>Открыть каталог</button>
          </div>
        </div>
      ) : (
        <div className="grid cards">
          {list.map((i) => {
            const isRun = running.includes(i.id)
            return (
              <div key={i.id} className={`card inst-card ${isRun ? 'running' : ''}`} onClick={() => go('instance', i.id)}>
                <div className="glow" />
                <div className="row">
                  <InstanceIcon inst={i} />
                  <div className="grow">
                    <div className="title ellipsis">{i.name}</div>
                    <div className="small muted">{timeAgo(i.lastPlayed)}</div>
                  </div>
                </div>
                <div className="meta">
                  <span className="chip accent">{i.mcVersion}</span>
                  <span className="chip"><LoaderIcon loader={i.loader} size={12} /> {loaderLabel(i.loader)}</span>
                  {i.source?.type && i.source.type !== 'file' && <span className="chip">{i.source.type}</span>}
                </div>
                <div className="bottom">
                  {isRun && <span className="chip ok">В игре</span>}
                  <button
                    className={`btn sm ${isRun ? 'danger' : 'primary'} play-mini ${isRun ? 'running' : ''}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      isRun ? api.stop(i.id) : play(i.id)
                    }}
                  >
                    {isRun ? <Square size={13} /> : <Play size={13} fill="currentColor" />} {isRun ? 'Стоп' : 'Играть'}
                  </button>
                </div>
              </div>
            )
          })}
          <div className="card inst-card new" onClick={() => setCreateOpen(true)}>
            <Plus size={28} />
            Новая сборка
          </div>
        </div>
      )}

      {cloudOnly.length > 0 && (
        <>
          <h2 className="row" style={{ marginTop: 30, fontSize: 18 }}>
            <Cloud size={18} /> В облаке — можно скачать на этот ПК
          </h2>
          <div className="grid cards">
            {cloudOnly.map((c) => (
              <div key={c.id} className="card inst-card" style={{ borderStyle: 'dashed' }}>
                <div className="glow" />
                <div className="row">
                  <InstanceIcon inst={c} />
                  <div className="grow">
                    <div className="title ellipsis">{c.name}</div>
                    <div className="small muted">с ПК {c.device} · {timeAgo(c.updatedAt)}</div>
                  </div>
                </div>
                <div className="meta">
                  <span className="chip accent">{c.mcVersion}</span>
                  <span className="chip">{loaderLabel(c.loader)}</span>
                  <span className="chip">{c.files} файлов</span>
                </div>
                <div className="bottom">
                  <PullButton item={c} small />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
