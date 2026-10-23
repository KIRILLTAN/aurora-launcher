import { useState } from 'react'
import { AlertOctagon, Sparkles, Copy, Puzzle, Play, FolderOpen, Settings, Wrench } from 'lucide-react'
import { api } from '../api'
import { useStore } from '../store'
import { Modal, Markdown, Spinner } from '../components/ui'

export default function CrashDialog() {
  const { crash, setCrash, instances, play, go, toast } = useStore()
  const [ai, setAi] = useState<string>()
  const [aiErr, setAiErr] = useState<string>()
  const [loading, setLoading] = useState(false)
  const [showLog, setShowLog] = useState(false)
  if (!crash) return null
  const inst = instances.find((i) => i.id === crash.instanceId)
  const close = (): void => setCrash(undefined)

  const ask = async (): Promise<void> => {
    setLoading(true)
    setAiErr(undefined)
    try {
      setAi(await api.askAi(crash.instanceId, crash, crash.java || 'неизвестно'))
    } catch (e) {
      setAiErr((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={crash.title}
      icon={<AlertOctagon size={22} color="var(--danger)" />}
      size="wide"
      onClose={close}
      footer={
        <>
          <button className="btn ghost" onClick={() => navigator.clipboard.writeText(`${crash.crashReport || ''}\n\n${crash.logTail}`).then(() => toast('Лог скопирован'))}>
            <Copy size={15} /> Копировать лог
          </button>
          <button className="btn ghost" onClick={() => api.openInstanceFolder(crash.instanceId, 'crash-reports')}>
            <FolderOpen size={15} /> Краш-репорты
          </button>
          <span className="grow" />
          {inst && inst.loader !== 'vanilla' && (
            <button className="btn" onClick={() => { close(); go('instance', crash.instanceId) }}>
              <Puzzle size={15} /> К модам
            </button>
          )}
          <button className="btn primary" onClick={() => { close(); play(crash.instanceId) }}>
            <Play size={15} fill="currentColor" /> Запустить снова
          </button>
        </>
      }
    >
      <div className="col" style={{ gap: 14 }}>
        <div className="muted">
          {inst?.name} · Minecraft {inst?.mcVersion} · {crash.summary}
        </div>

        {crash.suspectedMods.length > 0 && (
          <div className="row wrap">
            <b>Подозреваемые моды:</b>
            {crash.suspectedMods.map((m) => (
              <span key={m} className="chip danger">{m}</span>
            ))}
          </div>
        )}

        {crash.causes.map((c, i) => (
          <div key={i} className={`cause ${c.severity}`}>
            <Wrench size={20} color={c.severity === 'high' ? 'var(--danger)' : c.severity === 'medium' ? 'var(--warn)' : 'var(--muted)'} style={{ flex: 'none', marginTop: 2 }} />
            <div className="grow">
              <h4>{c.title}</h4>
              <pre className="selectable">{c.detail}</pre>
              {c.fix && <div className="fix"><b>Как исправить:</b> {c.fix}</div>}
            </div>
          </div>
        ))}

        <div className="ai-box">
          <div className="row" style={{ marginBottom: ai || aiErr ? 10 : 0 }}>
            <Sparkles size={20} color="var(--a2)" />
            <div className="grow">
              <b>ИИ-разбор краша</b>
              <div className="small muted">Claude прочитает лог, краш-репорт и список модов и объяснит, что конфликтует</div>
            </div>
            {crash.aiAvailable ? (
              <button className="btn primary" disabled={loading} onClick={ask}>
                {loading ? <Spinner /> : <Sparkles size={15} />} {ai ? 'Спросить ещё раз' : 'Спросить ИИ'}
              </button>
            ) : (
              <button className="btn" onClick={() => { close(); go('settings') }}>
                <Settings size={15} /> Добавить ключ Claude
              </button>
            )}
          </div>
          {loading && <div className="muted small">Анализирую лог… это займёт до минуты.</div>}
          {aiErr && <div style={{ color: 'var(--danger)' }}>{aiErr}</div>}
          {ai && <Markdown text={ai} />}
        </div>

        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setShowLog(!showLog)}>
          {showLog ? 'Скрыть лог' : 'Показать последние строки лога'}
        </button>
        {showLog && <div className="console" style={{ height: 300 }}>{crash.crashReport ? crash.crashReport.slice(0, 20000) : crash.logTail}</div>}
      </div>
    </Modal>
  )
}
