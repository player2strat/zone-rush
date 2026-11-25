// =============================================================================
// Foray — Challenge Manager (admin only)
// Route: /admin/challenges
//
// Day-to-day challenge editing in the app: search and filter, switch a
// challenge on or off, edit wording / difficulty / photo-video / tags, add a
// new one, see how each has done across games, and download everything as a
// spreadsheet in the same layout the Import Challenges page reads.
//
// Challenges are never deleted: "Off" (is_active false) keeps a challenge and
// its history but stops it being dealt in new games. Every change saves to
// the live app straight away.
// =============================================================================

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, doc, getDocs, serverTimestamp, setDoc, updateDoc } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import {
  CHALLENGE_TAGS, POINTS, challengesToCsv, newChallengeDoc, nextChallengeId, sortTags, tagLabel, titleFor,
  type AppChallenge, type Difficulty, type Verification,
} from '../lib/challengeImport'
import { loadAllChallengeStats } from '../lib/gameExport'
import { saveBlob } from '../lib/exportFiles'
import { nyDate } from '../lib/exportFormat'
import { completionRate, type TagStatRow } from '../lib/tagStats'

interface Managed extends AppChallenge {
  points?: number
  steps?: string[]
  final_task?: string
}

interface Form {
  text: string
  difficulty: Difficulty
  verification: Verification
  tags: string[]
  active: boolean
}

type Editing = { mode: 'edit'; id: string } | { mode: 'new' } | null

const ANY = '*'
const NO_TAGS = '-'
const idNumber = (id: string) => Number(/_(\d+)$/.exec(id)?.[1] ?? Number.MAX_SAFE_INTEGER)
const cap = (s = '') => s.charAt(0).toUpperCase() + s.slice(1)
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

async function loadChallenges(): Promise<Managed[]> {
  const snap = await getDocs(collection(db, 'challenges'))
  return snap.docs
    .map((d) => ({ ...(d.data() as Managed), id: d.id }))
    .sort((a, b) => idNumber(a.id) - idNumber(b.id) || a.id.localeCompare(b.id))
}

function formFor(c: Managed): Form {
  return {
    text: c.description ?? c.title ?? '',
    difficulty: (['easy', 'medium', 'hard'].includes(c.difficulty ?? '') ? c.difficulty : 'medium') as Difficulty,
    verification: (['photo', 'video', 'audio'].includes(c.verification_type ?? '') ? c.verification_type : 'photo') as Verification,
    tags: sortTags(c.tags ?? []),
    active: c.is_active !== false,
  }
}

const EMPTY_FORM: Form = { text: '', difficulty: 'easy', verification: 'photo', tags: [], active: true }

export default function ChallengeManagerPage() {
  const navigate = useNavigate()
  const [challenges, setChallenges] = useState<Managed[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'all' | 'on' | 'off'>('all')
  const [difficulty, setDifficulty] = useState(ANY)
  const [type, setType] = useState(ANY)
  const [tag, setTag] = useState(ANY)
  const [stats, setStats] = useState<{ byId: Map<string, TagStatRow>; games: number; practice: boolean } | 'loading' | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [toggling, setToggling] = useState<string | null>(null)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    loadChallenges().then(setChallenges).catch((err) => setLoadError((err as Error).message))
  }, [])

  // Every tag in use plus the standard ones, in the sheet's order.
  const tagOptions = useMemo(
    () => sortTags([...CHALLENGE_TAGS.map((t) => t.key), ...(challenges ?? []).flatMap((c) => c.tags ?? [])]),
    [challenges],
  )

  const shown = useMemo(() => {
    const q = squash(search)
    return (challenges ?? []).filter((c) => {
      if (status === 'on' && c.is_active === false) return false
      if (status === 'off' && c.is_active !== false) return false
      if (difficulty !== ANY && c.difficulty !== difficulty) return false
      if (type !== ANY && c.verification_type !== type) return false
      if (tag === NO_TAGS && (c.tags ?? []).length > 0) return false
      if (tag !== ANY && tag !== NO_TAGS && !(c.tags ?? []).includes(tag)) return false
      if (q && !squash(`${c.id} ${c.description ?? ''} ${c.title ?? ''}`).includes(q)) return false
      return true
    })
  }, [challenges, search, status, difficulty, type, tag])

  const onCount = challenges?.filter((c) => c.is_active !== false).length ?? 0
  const editingChallenge = editing?.mode === 'edit' ? challenges?.find((c) => c.id === editing.id) : undefined
  const isSequential = editingChallenge?.challenge_type === 'sequential'
  const newId = challenges ? nextChallengeId(challenges.map((c) => c.id)) : ''

  const patchLocal = (id: string, patch: Partial<Managed>) =>
    setChallenges((prev) => prev?.map((c) => (c.id === id ? { ...c, ...patch } : c)) ?? prev)

  const toggle = async (c: Managed) => {
    const next = c.is_active === false
    setToggling(c.id)
    setMessage(null)
    try {
      await updateDoc(doc(db, 'challenges', c.id), { is_active: next, updated_at: serverTimestamp() })
      patchLocal(c.id, { is_active: next })
      setMessage({ ok: true, text: `${c.id} is now ${next ? 'on: it can be dealt in new games' : 'off: it won\'t be dealt in new games'}.` })
    } catch (err) {
      setMessage({ ok: false, text: `Couldn't switch ${c.id}: ${(err as Error).message}` })
    } finally {
      setToggling(null)
    }
  }

  const openEdit = (c: Managed) => { setForm(formFor(c)); setFormError(null); setEditing({ mode: 'edit', id: c.id }) }
  const openNew = () => { setForm(EMPTY_FORM); setFormError(null); setEditing({ mode: 'new' }) }
  const close = () => { if (!saving) setEditing(null) }

  const save = async () => {
    const text = form.text.trim().replace(/\s+/g, ' ')
    if (!text) { setFormError('Write the challenge first.'); return }
    setSaving(true)
    setFormError(null)
    try {
      if (editing?.mode === 'new') {
        const id = newId
        const data = newChallengeDoc(id, { ...form, text }, auth.currentUser?.uid ?? '')
        await setDoc(doc(db, 'challenges', id), { ...data, created_at: serverTimestamp(), updated_at: serverTimestamp() })
        setChallenges((prev) => [...(prev ?? []), data as unknown as Managed])
        setMessage({ ok: true, text: `Added ${id}.${form.active ? ' It can be dealt in new games now.' : ' It\'s off until you switch it on.'}` })
      } else if (editingChallenge) {
        const c = editingChallenge
        const patch: Record<string, unknown> = {}
        if (!isSequential && text !== (c.description ?? '')) { patch.description = text; patch.title = titleFor(text) }
        if (form.difficulty !== c.difficulty) { patch.difficulty = form.difficulty; patch.points = POINTS[form.difficulty] }
        if (form.verification !== c.verification_type) patch.verification_type = form.verification
        const before = sortTags(c.tags ?? [])
        if (before.join() !== form.tags.join() || !Array.isArray(c.tags)) patch.tags = form.tags
        if (form.active !== (c.is_active !== false)) patch.is_active = form.active
        if (Object.keys(patch).length === 0) { setEditing(null); setSaving(false); return }
        await updateDoc(doc(db, 'challenges', c.id), { ...patch, updated_at: serverTimestamp() })
        patchLocal(c.id, patch as Partial<Managed>)
        setMessage({ ok: true, text: `Saved ${c.id}.` })
      }
      setEditing(null)
    } catch (err) {
      setFormError(`Couldn't save: ${(err as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  const loadStats = (practice: boolean) => {
    setStats('loading')
    setStatsError(null)
    loadAllChallengeStats(practice)
      .then(({ stats: byId, games }) => setStats({ byId, games, practice }))
      .catch((err) => { setStats(null); setStatsError((err as Error).message) })
  }

  const download = () => {
    if (!challenges) return
    saveBlob(new Blob([challengesToCsv(challenges)], { type: 'text/csv;charset=utf-8' }), `foray-challenges_${nyDate(new Date())}.csv`)
  }

  // ─── Styles ────────────────────────────────────────────────────────────────
  const button = (kind: 'primary' | 'plain', enabled = true): CSSProperties => ({
    background: !enabled ? 'rgba(var(--ink-rgb), 0.03)' : kind === 'primary' ? 'rgba(var(--pink-rgb), 0.15)' : 'var(--surface)',
    border: `1px solid ${!enabled ? 'var(--line)' : kind === 'primary' ? 'rgba(var(--pink-rgb), 0.45)' : 'var(--line-strong)'}`,
    color: !enabled ? 'var(--ink-ghost)' : kind === 'primary' ? 'var(--pink-deep)' : 'var(--ink-soft)',
    padding: '9px 14px', borderRadius: 8, fontSize: '0.82rem', fontWeight: 700,
    cursor: enabled ? 'pointer' : 'not-allowed', fontFamily: 'inherit', whiteSpace: 'nowrap',
  })
  const select: CSSProperties = {
    background: 'var(--surface)', border: '1px solid var(--line-strong)', color: 'var(--ink)',
    padding: '8px 10px', borderRadius: 8, fontSize: '0.82rem', fontFamily: 'inherit', maxWidth: '100%',
  }
  const chip = (bg: string, fg: string): CSSProperties => ({ fontSize: '0.7rem', fontWeight: 600, padding: '1px 8px', borderRadius: 99, background: bg, color: fg, whiteSpace: 'nowrap' })
  const label: CSSProperties = { display: 'block', fontSize: '0.78rem', fontWeight: 700, color: 'var(--ink-muted)', margin: '14px 0 6px' }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", padding: '24px 16px' }}>
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}>
          ← Home
        </button>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 6px' }}>Challenge Manager</h1>
        <p style={{ color: 'var(--ink-muted)', fontSize: '0.88rem', lineHeight: 1.5, margin: '0 0 16px' }}>
          Edit, add and switch challenges on or off. Changes save to the live app right away. Challenges are
          never deleted: switching one off keeps it and its history but stops it being dealt in new games.
        </p>

        {loadError && <p style={{ color: 'var(--red-deep)', fontSize: '0.85rem' }}>Couldn't load challenges: {loadError}</p>}
        {!challenges && !loadError && <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>Loading challenges…</p>}

        {challenges && (
          <>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              <button onClick={openNew} style={button('primary')}>+ Add challenge</button>
              <button onClick={download} style={button('plain')}>Download as spreadsheet</button>
              <button
                onClick={() => loadStats(stats !== 'loading' && stats !== null ? stats.practice : false)}
                disabled={stats === 'loading'}
                style={button('plain', stats !== 'loading')}
              >
                {stats === 'loading' ? 'Counting games…' : stats ? 'Refresh performance' : 'Show performance'}
              </button>
            </div>
            {statsError && <p style={{ color: 'var(--red-deep)', fontSize: '0.82rem', margin: '0 0 10px' }}>Couldn't load performance: {statsError}</p>}
            {stats && stats !== 'loading' && (
              <p style={{ color: 'var(--ink-muted)', fontSize: '0.8rem', margin: '0 0 10px', display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                <span>Performance across {stats.games} game{stats.games === 1 ? '' : 's'}{stats.practice ? ', practice games included' : ', not counting practice games'}. Counted per team.</span>
                <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={stats.practice} onChange={(e) => loadStats(e.target.checked)} />
                  Include practice games
                </label>
              </p>
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search wording or ID"
                style={{ ...select, flex: '1 1 220px' }}
              />
              <select value={status} onChange={(e) => setStatus(e.target.value as 'all' | 'on' | 'off')} style={select}>
                <option value="all">On and off</option>
                <option value="on">On only</option>
                <option value="off">Off only</option>
              </select>
              <select value={difficulty} onChange={(e) => setDifficulty(e.target.value)} style={select}>
                <option value={ANY}>Any difficulty</option>
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
              <select value={type} onChange={(e) => setType(e.target.value)} style={select}>
                <option value={ANY}>Photo or video</option>
                <option value="photo">Photo</option>
                <option value="video">Video</option>
              </select>
              <select value={tag} onChange={(e) => setTag(e.target.value)} style={select}>
                <option value={ANY}>Any tag</option>
                {tagOptions.map((k) => <option key={k} value={k}>{tagLabel(k)}</option>)}
                <option value={NO_TAGS}>No tags</option>
              </select>
            </div>
            <p style={{ color: 'var(--ink-faint)', fontSize: '0.8rem', margin: '0 0 10px' }}>
              Showing {shown.length} of {challenges.length} challenges ({onCount} on).
            </p>
            {message && (
              <p style={{ fontSize: '0.84rem', fontWeight: 600, margin: '0 0 10px', color: message.ok ? 'var(--green-deep)' : 'var(--red-deep)' }}>{message.text}</p>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shown.map((c) => {
                const on = c.is_active !== false
                const s = stats && stats !== 'loading' ? stats.byId.get(c.id) : undefined
                return (
                  <div key={c.id} style={{
                    background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: '10px 12px',
                    display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', opacity: on ? 1 : 0.62,
                  }}>
                    <div style={{ flex: '1 1 300px', minWidth: 0 }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 3 }}>
                        <strong style={{ fontSize: '0.8rem' }}>{c.id}</strong>
                        <span style={chip('rgba(var(--ink-rgb), 0.06)', 'var(--ink-soft)')}>{cap(c.difficulty)}</span>
                        <span style={chip('rgba(var(--ink-rgb), 0.06)', 'var(--ink-soft)')}>{cap(c.verification_type)}</span>
                        {c.challenge_type === 'sequential' && <span style={chip('rgba(var(--marigold-rgb), 0.25)', 'var(--marigold-deep)')}>Choose Your Own Adventure</span>}
                        {!on && <span style={chip('rgba(var(--red-rgb), 0.12)', 'var(--red-deep)')}>Off</span>}
                      </div>
                      <div style={{ fontSize: '0.86rem', lineHeight: 1.4, overflowWrap: 'anywhere' }}>{c.description || c.title}</div>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 5 }}>
                        {(c.tags ?? []).length === 0
                          ? <span style={{ fontSize: '0.72rem', color: 'var(--ink-ghost)' }}>No tags</span>
                          : sortTags(c.tags ?? []).map((t) => <span key={t} style={chip('rgba(var(--blue-rgb), 0.12)', 'var(--ink-soft)')}>{tagLabel(t)}</span>)}
                      </div>
                      {stats && stats !== 'loading' && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--ink-muted)', marginTop: 5 }}>
                          {s && s.held > 0
                            ? `Held ${s.held} · Completed ${s.completed} (${completionRate(s)}) · Rejected ${s.rejected} · Discarded ${s.discarded} · ${s.points} pts`
                            : 'Not dealt in any counted game yet'}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <button
                        onClick={() => toggle(c)}
                        disabled={toggling === c.id}
                        aria-pressed={on}
                        title={on ? 'Switch off: stop dealing it in new games' : 'Switch on: deal it in new games'}
                        style={{
                          ...button('plain', toggling !== c.id),
                          minWidth: 64,
                          background: on ? 'rgba(var(--green-rgb), 0.16)' : 'rgba(var(--ink-rgb), 0.05)',
                          color: on ? 'var(--green-deep)' : 'var(--ink-muted)',
                          borderColor: on ? 'rgba(var(--green-rgb), 0.5)' : 'var(--line-strong)',
                        }}
                      >
                        {toggling === c.id ? '…' : on ? 'On' : 'Off'}
                      </button>
                      <button onClick={() => openEdit(c)} style={button('plain')}>Edit</button>
                    </div>
                  </div>
                )
              })}
              {shown.length === 0 && <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>No challenges match these filters.</p>}
            </div>
          </>
        )}
      </div>

      {editing && (
        <div onClick={close} style={{ position: 'fixed', inset: 0, background: 'rgba(0, 0, 0, 0.4)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 16px', overflowY: 'auto', zIndex: 50 }}>
          <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ background: 'var(--paper)', borderRadius: 14, padding: 20, width: '100%', maxWidth: 560, boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)' }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 800, margin: 0 }}>
              {editing.mode === 'new' ? `New challenge (${newId})` : `Edit ${editing.id}`}
            </h2>

            <span style={label}>Challenge</span>
            {isSequential ? (
              <div style={{ fontSize: '0.85rem', lineHeight: 1.5, color: 'var(--ink-soft)' }}>
                <strong>{editingChallenge?.title}</strong>
                <ol style={{ margin: '4px 0', paddingLeft: 20 }}>{(editingChallenge?.steps ?? []).map((st) => <li key={st}>{st}</li>)}</ol>
                <div>Then: {editingChallenge?.final_task}</div>
                <div style={{ color: 'var(--ink-faint)', fontSize: '0.78rem', marginTop: 6 }}>Choose Your Own Adventure steps can't be edited here yet. Everything else below can.</div>
              </div>
            ) : (
              <textarea
                value={form.text}
                onChange={(e) => setForm({ ...form, text: e.target.value })}
                rows={4}
                placeholder="e.g. Woof. Take a picture with at least 3 dogs in frame"
                style={{ width: '100%', boxSizing: 'border-box', ...select, fontSize: '0.88rem', lineHeight: 1.45, resize: 'vertical' }}
              />
            )}

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
              <div>
                <span style={label}>Difficulty</span>
                <select value={form.difficulty} onChange={(e) => setForm({ ...form, difficulty: e.target.value as Difficulty })} style={select}>
                  <option value="easy">Easy ({POINTS.easy} pt)</option>
                  <option value="medium">Medium ({POINTS.medium} pts)</option>
                  <option value="hard">Hard ({POINTS.hard} pts)</option>
                </select>
              </div>
              <div>
                <span style={label}>Proof</span>
                <select value={form.verification} onChange={(e) => setForm({ ...form, verification: e.target.value as Verification })} style={select}>
                  <option value="photo">Photo</option>
                  <option value="video">Video</option>
                </select>
              </div>
              <div>
                <span style={label}>Status</span>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.85rem', paddingTop: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  On (dealt in new games)
                </label>
              </div>
            </div>

            <span style={label}>Tags</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '6px 12px' }}>
              {tagOptions.map((k) => (
                <label key={k} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: '0.84rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={form.tags.includes(k)}
                    onChange={(e) => setForm({ ...form, tags: sortTags(e.target.checked ? [...form.tags, k] : form.tags.filter((t) => t !== k)) })}
                  />
                  {tagLabel(k)}
                </label>
              ))}
            </div>

            {editing.mode === 'edit' && form.difficulty !== editingChallenge?.difficulty && (
              <p style={{ color: 'var(--ink-faint)', fontSize: '0.78rem', margin: '12px 0 0' }}>A new difficulty changes points in future games only. Past scores stay as they are.</p>
            )}
            {formError && <p style={{ color: 'var(--red-deep)', fontSize: '0.84rem', fontWeight: 600, margin: '12px 0 0' }}>{formError}</p>}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button onClick={close} disabled={saving} style={button('plain', !saving)}>Cancel</button>
              <button onClick={save} disabled={saving} style={button('primary', !saving)}>
                {saving ? 'Saving…' : editing.mode === 'new' ? 'Add challenge' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
