import { useMemo, useState } from 'react'
import { Plus, Play, Square, Search, Boxes, Upload } from 'lucide-react'
import type { LoaderType } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'
import { InstanceIcon, loaderLabel, timeAgo, LOADERS } from '../components/ui'

export default function LibraryPage() {
  const { instances, running, play, go, setCreateOpen, toast } = useStore()
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
    for (const f of Array.from(e.dataTransfer.files)) {
      const p = api.pathForFile(f)
      if (!/\.(mrpack|zip)$/i.test(p)) continue
      try {
        const inst = await api.importFile(p)
        toast(`Импортирована сборка «${inst.name}»`, 'success')
      } catch (err) {
        toast((err as Error).message, 'error')
      }
    }
  }

  return (
    <div className="page" onDragOver={(e) => (e.preventDefault(), setOver(true))} onDragLeave={() => setOver(false)} onDrop={onDrop}>
      <div className="page-header">
        <div>
          <h1>Мои сборки</h1>
          <p>Перетащите .mrpack или .zip сюда, чтобы импортировать</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={async () => {
            const [file] = await api.openFile([{ name: 'Сборки', extensions: ['mrpack', 'zip'] }])
            if (file) api.importFile(file).then((i) => toast(`Импортирована «${i.name}»`, 'success')).catch((e) => toast(e.message, 'error'))
          }}>
            <Upload size={16} /> Импорт
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
            <button key={l.id} className={loader === l.id ? 'active' : ''} onClick={() => setLoader(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </div>

      {over && <div className="drop-zone over" style={{ marginBottom: 16 }}>Отпустите файл для импорта сборки</div>}

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
                  <span className="chip">{loaderLabel(i.loader)}</span>
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
    </div>
  )
}
