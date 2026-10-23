import { useEffect, useState } from 'react'
import { Search, Download, ExternalLink, Heart, ListFilter, ChevronLeft, ChevronRight, KeyRound } from 'lucide-react'
import type { CatalogItem, CatalogVersion, Instance, LoaderType } from '@shared/types'
import { api, type CatalogType } from '../api'
import { useStore } from '../store'
import { fmtNum, Modal, Spinner, LOADERS } from '../components/ui'

export default function CatalogPage() {
  const [type, setType] = useState<CatalogType>('modpack')
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Каталог</h1>
          <p>Модпаки, моды, ресурспаки и шейдеры с Modrinth и CurseForge</p>
        </div>
        <div className="actions">
          <div className="seg">
            {([
              ['modpack', 'Модпаки'],
              ['mod', 'Моды'],
              ['resourcepack', 'Ресурспаки'],
              ['shader', 'Шейдеры']
            ] as [CatalogType, string][]).map(([id, label]) => (
              <button key={id} className={type === id ? 'active' : ''} onClick={() => setType(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <CatalogBrowser key={type} type={type} />
    </div>
  )
}

/** Поиск и установка. Без instance — модпаки ставятся как новые сборки; с instance — моды ставятся в неё. */
export function CatalogBrowser({ type, instance, onInstalled }: { type: CatalogType; instance?: Instance; onInstalled?: (inst?: Instance) => void }) {
  const { toast, settings, go, refreshInstances } = useStore()
  const [source, setSource] = useState<'modrinth' | 'curseforge'>('modrinth')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [gameVersion, setGameVersion] = useState(instance?.mcVersion || '')
  const [loader, setLoader] = useState<LoaderType | ''>(instance && type === 'mod' ? instance.loader : '')
  const [sort, setSort] = useState('relevance')
  const [offset, setOffset] = useState(0)
  const [res, setRes] = useState<{ items: CatalogItem[]; total: number } | null>(null)
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [versionsFor, setVersionsFor] = useState<CatalogItem | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 350)
    return () => clearTimeout(t)
  }, [query])
  useEffect(() => setOffset(0), [debounced, source, gameVersion, loader, sort])
  useEffect(() => {
    let alive = true
    setLoading(true)
    setError(undefined)
    api
      .search(source, { query: debounced, type, gameVersion: gameVersion || undefined, loader: (loader || undefined) as LoaderType | undefined, sort, offset })
      .then((r) => alive && setRes(r))
      .catch((e) => alive && (setError(e.message), setRes(null)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [source, debounced, type, gameVersion, loader, sort, offset])

  const install = async (item: CatalogItem, versionId?: string): Promise<void> => {
    setBusy((b) => ({ ...b, [item.id]: true }))
    try {
      if (type === 'modpack') {
        const inst = await api.installPack(item.source, item.id, versionId)
        toast(`Сборка «${inst.name}» установлена`, 'success')
        await refreshInstances()
        onInstalled?.(inst)
        if (!instance) go('instance', inst.id)
      } else {
        if (!instance) {
          toast('Откройте сборку и добавляйте моды из вкладки «Моды»', 'info')
          return
        }
        const files = await api.installProject(item.source, instance.id, item.id, type, versionId)
        toast(`Установлено: ${files.join(', ')}`, 'success')
        onInstalled?.()
      }
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy((b) => ({ ...b, [item.id]: false }))
    }
  }

  const needsKey = source === 'curseforge' && !settings?.hasCurseforgeKey

  return (
    <div>
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div className="seg">
          <button className={source === 'modrinth' ? 'active' : ''} onClick={() => setSource('modrinth')}>Modrinth</button>
          <button className={source === 'curseforge' ? 'active' : ''} onClick={() => setSource('curseforge')}>CurseForge</button>
        </div>
        <div className="search grow" style={{ minWidth: 220 }}>
          <Search size={16} />
          <input className="input" placeholder="Поиск…" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        </div>
        <input className="input" style={{ width: 120 }} placeholder="Версия MC" value={gameVersion} onChange={(e) => setGameVersion(e.target.value.trim())} />
        {type === 'mod' && (
          <select className="select" style={{ width: 140 }} value={loader} onChange={(e) => setLoader(e.target.value as LoaderType | '')}>
            <option value="">Любой загрузчик</option>
            {LOADERS.filter((l) => l.id !== 'vanilla').map((l) => (
              <option key={l.id} value={l.id}>{l.label}</option>
            ))}
          </select>
        )}
        {source === 'modrinth' && (
          <select className="select" style={{ width: 200 }} value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="relevance">По релевантности</option>
            <option value="downloads">По загрузкам</option>
            <option value="follows">По популярности</option>
            <option value="newest">Новые</option>
            <option value="updated">Обновлённые</option>
          </select>
        )}
      </div>

      {needsKey && (
        <div className="card pad row" style={{ marginBottom: 16 }}>
          <KeyRound size={20} />
          <div className="grow">
            <b>Нужен ключ CurseForge API</b>
            <div className="small muted">CurseForge выдаёт его бесплатно на console.curseforge.com. Вставьте ключ в Настройках.</div>
          </div>
          <button className="btn" onClick={() => api.openUrl('https://console.curseforge.com/')}><ExternalLink size={14} /> Получить</button>
          <button className="btn primary" onClick={() => go('settings')}>В настройки</button>
        </div>
      )}

      {loading && <div className="row muted" style={{ padding: 20 }}><Spinner /> Поиск…</div>}
      {error && !needsKey && <div className="card pad" style={{ color: 'var(--danger)' }}>{error}</div>}
      {res && !loading && res.items.length === 0 && <div className="empty"><ListFilter size={40} />Ничего не найдено</div>}
      {res && !loading && (
        <div className="catalog-list">
          {res.items.map((it) => (
            <div key={it.id} className="card catalog-item">
              {it.icon ? <img src={it.icon} loading="lazy" /> : <div className="ph" />}
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row">
                  <h4 className="ellipsis">{it.title}</h4>
                  {it.author && <span className="small muted ellipsis">от {it.author}</span>}
                </div>
                <div className="desc">{it.description}</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  <span className="chip"><Download size={11} /> {fmtNum(it.downloads)}</span>
                  {it.follows !== undefined && <span className="chip"><Heart size={11} /> {fmtNum(it.follows)}</span>}
                  {it.categories.slice(0, 3).map((c) => <span key={c} className="chip">{c}</span>)}
                </div>
              </div>
              <div className="col" style={{ justifyContent: 'center' }}>
                <button className="btn sm primary" disabled={busy[it.id]} onClick={() => install(it)}>
                  {busy[it.id] ? <Spinner /> : <Download size={14} />} Установить
                </button>
                <button className="btn sm" onClick={() => setVersionsFor(it)}>Версии</button>
                {it.url && <button className="btn sm ghost" onClick={() => api.openUrl(it.url!)}><ExternalLink size={13} /> Сайт</button>}
              </div>
            </div>
          ))}
        </div>
      )}
      {res && res.total > 24 && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 18 }}>
          <button className="btn icon" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 24))}><ChevronLeft size={16} /></button>
          <span className="muted">Страница {offset / 24 + 1} из {Math.ceil(Math.min(res.total, 10000) / 24)}</span>
          <button className="btn icon" disabled={offset + 24 >= res.total} onClick={() => setOffset(offset + 24)}><ChevronRight size={16} /></button>
        </div>
      )}

      {versionsFor && (
        <VersionsModal
          item={versionsFor}
          mc={type === 'modpack' ? gameVersion : instance?.mcVersion}
          loader={type === 'mod' ? instance?.loader : undefined}
          onClose={() => setVersionsFor(null)}
          onPick={(v) => {
            const it = versionsFor
            setVersionsFor(null)
            install(it, v.id)
          }}
        />
      )}
    </div>
  )
}

function VersionsModal({ item, mc, loader, onClose, onPick }: { item: CatalogItem; mc?: string; loader?: string; onClose: () => void; onPick: (v: CatalogVersion) => void }) {
  const [list, setList] = useState<CatalogVersion[] | null>(null)
  const [err, setErr] = useState<string>()
  useEffect(() => {
    api.catalogVersions(item.source, item.id, mc || undefined, loader).then(setList).catch((e) => setErr(e.message))
  }, [item.id])
  return (
    <Modal title={`Версии: ${item.title}`} onClose={onClose}>
      {!list && !err && <div className="row muted"><Spinner /> Загрузка…</div>}
      {err && <div style={{ color: 'var(--danger)' }}>{err}</div>}
      {list && list.length === 0 && <div className="muted">Нет подходящих версий{mc ? ` для ${mc}` : ''}.</div>}
      <div className="list">
        {list?.map((v) => (
          <div key={v.id} className="list-row">
            <div className="grow">
              <b>{v.name}</b>
              <div className="small muted">
                {v.gameVersions.slice(0, 6).join(', ')} · {v.loaders.join(', ')} · {new Date(v.date).toLocaleDateString('ru-RU')}
              </div>
            </div>
            <button className="btn sm primary" onClick={() => onPick(v)}>Установить</button>
          </div>
        ))}
      </div>
    </Modal>
  )
}
