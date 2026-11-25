// =============================================================================
// Foray — Import Challenges (admin only)
// Route: /admin/import-challenges
//
// Brings the challenge spreadsheet into the live app: tags, reworded text,
// difficulty and photo/video for existing challenges, plus new challenges.
// Active challenges missing from the sheet are switched off (never deleted,
// so past games still link to them).
//
// Choosing the CSV only shows a preview. Nothing is written until "Apply" is
// pressed and confirmed. The matching rules live in lib/challengeImport.ts.
// =============================================================================

import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from 'react-router-dom'
import { collection, doc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore'
import { auth, db } from '../lib/firebase'
import {
  buildWrites, idColumnText, parseChallengeSheet, parseCsv, planImport, rowsAreContiguous, tagLabel,
  type AppChallenge, type Change, type ImportPlan, type ParsedSheet, type PlanRow,
} from '../lib/challengeImport'

const BATCH_SIZE = 400   // Firestore allows 500 writes per batch

async function loadAppChallenges(): Promise<AppChallenge[]> {
  const snap = await getDocs(collection(db, 'challenges'))
  return snap.docs.map((d) => ({ ...(d.data() as AppChallenge), id: d.id }))
}

const KIND_STYLE: Record<PlanRow['kind'], { label: string; bg: string; fg: string }> = {
  update: { label: 'Update', bg: 'rgba(var(--blue-rgb), 0.16)', fg: 'var(--ink)' },
  unchanged: { label: 'No change', bg: 'rgba(var(--ink-rgb), 0.06)', fg: 'var(--ink-muted)' },
  new: { label: 'New', bg: 'rgba(var(--green-rgb), 0.16)', fg: 'var(--green-deep)' },
  skip: { label: 'Skipped', bg: 'rgba(var(--red-rgb), 0.12)', fg: 'var(--red-deep)' },
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

function changeText(c: Change): string {
  switch (c.field) {
    case 'tags': return `Tags: ${c.from.length ? c.from.map(tagLabel).join(', ') : 'none'} → ${c.to.length ? c.to.map(tagLabel).join(', ') : 'none'}`
    case 'wording': return `Wording: "${c.from}" → "${c.to}"`
    case 'difficulty': return `Difficulty: ${cap(c.from || 'none')} → ${cap(c.to)}`
    case 'type': return `Photo/video: ${cap(c.from || 'none')} → ${cap(c.to)}`
    case 'switch_on': return 'Switched back on (it was off)'
    case 'switch_off': return 'Switched off (Active is FALSE in the sheet)'
  }
}

export default function ImportChallengesPage() {
  const navigate = useNavigate()
  const [app, setApp] = useState<AppChallenge[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [sheet, setSheet] = useState<ParsedSheet | null>(null)
  const [filter, setFilter] = useState<'changes' | 'all'>('changes')
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    loadAppChallenges().then(setApp).catch((err) => setLoadError((err as Error).message))
  }, [])

  const plan: ImportPlan | null = useMemo(
    () => (sheet && app && sheet.problems.length === 0 ? planImport(sheet.rows, app) : null),
    [sheet, app],
  )
  const writes = useMemo(() => (plan ? buildWrites(plan, auth.currentUser?.uid ?? '') : []), [plan])
  const pending = plan ? plan.counts.update + plan.counts.new + plan.counts.switchOff : 0
  const needsCheck = plan?.rows.filter((r) => r.note && r.kind !== 'skip') ?? []

  const onFile = async (file: File | undefined) => {
    if (!file) return
    setResult(null)
    setCopied(false)
    setFileName(file.name)
    setSheet(parseChallengeSheet(parseCsv(await file.text())))
  }

  const apply = async () => {
    if (!plan || writes.length === 0) return
    const ok = window.confirm(
      `This changes the live app right away:\n\n` +
      `• ${plan.counts.update} challenges updated\n` +
      `• ${plan.counts.new} new challenges (dealt in games from now on)\n` +
      `• ${plan.counts.switchOff} switched off (not deleted)\n\nContinue?`,
    )
    if (!ok) return
    setApplying(true)
    setResult(null)
    let done = 0
    try {
      for (let i = 0; i < writes.length; i += BATCH_SIZE) {
        const batch = writeBatch(db)
        for (const w of writes.slice(i, i + BATCH_SIZE)) {
          const ref = doc(db, 'challenges', w.id)
          if (w.op === 'create') batch.set(ref, { ...w.data, created_at: serverTimestamp(), updated_at: serverTimestamp() })
          else batch.update(ref, { ...w.data, updated_at: serverTimestamp() })
        }
        await batch.commit()
        done += Math.min(BATCH_SIZE, writes.length - i)
      }
      setResult({ ok: true, text: `Done. Saved ${done} changes. The preview below is now checked against the updated app.` })
    } catch (err) {
      setResult({ ok: false, text: `Stopped after ${done} of ${writes.length} changes: ${(err as Error).message}. Choose the file again to see what's left.` })
    } finally {
      setApplying(false)
      loadAppChallenges().then(setApp).catch(() => {})
    }
  }

  const copyIds = async () => {
    if (!plan) return
    try {
      await navigator.clipboard.writeText(idColumnText(plan))
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  const card = (n: number, label: string, color: string) => (
    <div style={{ background: 'rgba(var(--ink-rgb), 0.03)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 8px', textAlign: 'center' }}>
      <p style={{ fontSize: '1.3rem', fontWeight: 700, color, margin: 0 }}>{n}</p>
      <p style={{ fontSize: '0.72rem', color: 'var(--ink-muted)', margin: 0 }}>{label}</p>
    </div>
  )
  const button = (primary: boolean, enabled: boolean): CSSProperties => ({
    background: !enabled ? 'rgba(var(--ink-rgb), 0.03)' : primary ? 'rgba(var(--pink-rgb), 0.15)' : 'var(--surface)',
    border: `1px solid ${!enabled ? 'var(--line)' : primary ? 'rgba(var(--pink-rgb), 0.45)' : 'var(--line-strong)'}`,
    color: !enabled ? 'var(--ink-ghost)' : primary ? 'var(--pink-deep)' : 'var(--ink-soft)',
    padding: '10px 16px', borderRadius: 8, fontSize: '0.85rem', fontWeight: 700,
    cursor: enabled ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
  })
  const section: CSSProperties = { margin: '24px 0 8px', fontSize: '1rem', fontWeight: 700 }
  const note: CSSProperties = { color: 'var(--ink-muted)', fontSize: '0.85rem', lineHeight: 1.5, margin: '0 0 10px' }

  const shownRows = plan?.rows.filter((r) => filter === 'all' || r.kind !== 'unchanged') ?? []

  return (
    <div style={{ minHeight: '100vh', background: 'var(--paper)', color: 'var(--ink)', fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", padding: '24px 16px' }}>
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        <button onClick={() => navigate('/')} style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}>
          ← Home
        </button>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 800, margin: '0 0 6px' }}>Import Challenges</h1>
        <p style={note}>
          Brings the challenge spreadsheet into the app: tags, wording, difficulty and photo/video for
          existing challenges, plus any new ones. Challenges missing from the sheet are switched off, not
          deleted, so past games keep their history. Nothing changes until you press Apply.
        </p>
        <ol style={{ ...note, paddingLeft: 20 }}>
          <li>In Google Sheets, open the challenges tab (e.g. "Gamma v1").</li>
          <li>File → Download → Comma Separated Values (.csv).</li>
          <li>Choose that file below and check the preview.</li>
        </ol>

        {loadError && <p style={{ color: 'var(--red-deep)', fontSize: '0.85rem' }}>Couldn't load the app's challenges: {loadError}</p>}
        {!app && !loadError && <p style={{ color: 'var(--ink-faint)', fontSize: '0.85rem' }}>Loading the app's challenges…</p>}
        {app && (
          <p style={{ ...note, color: 'var(--ink-soft)' }}>
            The app has {app.length} challenges ({app.filter((c) => c.is_active !== false).length} switched on).
          </p>
        )}

        <label style={{ ...button(false, !!app && !applying), display: 'inline-block' }}>
          {fileName ? 'Choose a different file' : 'Choose CSV file'}
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={!app || applying}
            onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = '' }}
            style={{ display: 'none' }}
          />
        </label>
        {fileName && <span style={{ marginLeft: 10, fontSize: '0.85rem', color: 'var(--ink-muted)' }}>{fileName}</span>}

        {sheet && sheet.problems.length > 0 && (
          <div style={{ marginTop: 16, color: 'var(--red-deep)', fontSize: '0.85rem', lineHeight: 1.5 }}>
            This file can't be imported:
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>{sheet.problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}

        {plan && sheet && (
          <>
            <h2 style={section}>Preview</h2>
            <p style={note}>
              {sheet.rows.length} challenges in the sheet, {sheet.tagKeys.length} tag columns: {sheet.tagKeys.map(tagLabel).join(', ')}.
              {sheet.hasIdColumn ? ' Rows are matched by their ID column.' : ' The sheet has no ID column yet, so rows are matched by their wording.'}
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 8 }}>
              {card(plan.counts.update, 'Updated', 'var(--blue)')}
              {card(plan.counts.new, 'New', 'var(--green-deep)')}
              {card(plan.counts.switchOff, 'Switched off', 'var(--marigold-deep)')}
              {card(plan.counts.unchanged, 'No change', 'var(--ink-soft)')}
              {card(plan.counts.skip, 'Skipped', 'var(--red-deep)')}
            </div>

            {needsCheck.length > 0 && (
              <>
                <h2 style={section}>Please check</h2>
                {needsCheck.map((r) => (
                  <div key={r.row.rowNumber} style={{ background: 'rgba(var(--marigold-rgb), 0.12)', border: '1px solid rgba(var(--marigold-rgb), 0.4)', borderRadius: 8, padding: '10px 12px', fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 8 }}>
                    <strong>Row {r.row.rowNumber} ({r.id}).</strong> {r.note}
                    {r.changes.filter((c) => c.field === 'wording').map((c) => <div key="w" style={{ color: 'var(--ink-soft)' }}>{changeText(c)}</div>)}
                  </div>
                ))}
              </>
            )}

            {plan.switchOff.length > 0 && (
              <>
                <h2 style={section}>Switched off (not in the sheet)</h2>
                {plan.switchOff.map((c) => (
                  <div key={c.id} style={{ fontSize: '0.85rem', lineHeight: 1.5, marginBottom: 6 }}>
                    <strong>{c.id}</strong> {c.description}
                  </div>
                ))}
              </>
            )}

            <h2 style={section}>ID column for the sheet</h2>
            <p style={note}>
              Every challenge keeps a permanent ID that games use, so renaming a challenge never breaks past games.
              Paste this into a new column A of the sheet (click cell A1 of the new column, then paste). After that,
              rows are matched by ID even if their wording changes.
              {!rowsAreContiguous(sheet.rows) && ' Careful: the sheet has blank rows between challenges, so this list won\'t line up. Remove the blank rows first.'}
              {plan.counts.new > 0 && ' New challenges get their IDs when you press Apply; these are the IDs they will get.'}
            </p>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={copyIds} style={button(false, true)}>Copy ID column</button>
              {copied && <span style={{ fontSize: '0.82rem', color: 'var(--green-deep)', fontWeight: 600 }}>Copied {plan.rows.length} IDs plus the header.</span>}
            </div>

            <h2 style={section}>Apply</h2>
            <p style={note}>
              {pending === 0
                ? 'The app already matches this sheet. Nothing to apply.'
                : `${writes.length} changes to the live app. New challenges are dealt in games from now on.`}
            </p>
            <button onClick={apply} disabled={pending === 0 || applying} style={button(true, pending > 0 && !applying)}>
              {applying ? 'Applying…' : 'Apply to the live app'}
            </button>
            {result && (
              <p style={{ marginTop: 10, fontSize: '0.85rem', fontWeight: 600, color: result.ok ? 'var(--green-deep)' : 'var(--red-deep)' }}>{result.text}</p>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', margin: '24px 0 8px' }}>
              <h2 style={{ ...section, margin: 0 }}>Every row</h2>
              <select value={filter} onChange={(e) => setFilter(e.target.value as 'changes' | 'all')} style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', color: 'var(--ink)', padding: '6px 8px', borderRadius: 8, fontSize: '0.82rem', fontFamily: 'inherit' }}>
                <option value="changes">Only rows with changes</option>
                <option value="all">All rows</option>
              </select>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shownRows.map((r) => {
                const k = KIND_STYLE[r.kind]
                return (
                  <div key={r.row.rowNumber} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px', fontSize: '0.82rem', lineHeight: 1.45 }}>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ color: 'var(--ink-faint)' }}>Row {r.row.rowNumber}</span>
                      {r.id && <strong>{r.id}</strong>}
                      <span style={{ fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: k.bg, color: k.fg }}>{k.label}</span>
                      <span style={{ color: 'var(--ink-muted)' }}>{cap(r.row.difficulty ?? '?')} · {cap(r.row.verification ?? '?')}</span>
                    </div>
                    <div style={{ margin: '4px 0', overflowWrap: 'anywhere' }}>{r.row.text}</div>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.row.tags.length === 0
                        ? <span style={{ color: 'var(--ink-ghost)' }}>No tags</span>
                        : r.row.tags.map((t) => (
                          <span key={t} style={{ fontSize: '0.7rem', padding: '1px 7px', borderRadius: 99, background: 'rgba(var(--ink-rgb), 0.06)', color: 'var(--ink-soft)' }}>{tagLabel(t)}</span>
                        ))}
                    </div>
                    {r.kind === 'skip' && <div style={{ color: 'var(--red-deep)', marginTop: 4 }}>{r.note}</div>}
                    {r.kind === 'update' && r.changes.filter((c) => c.field !== 'tags').map((c) => (
                      <div key={c.field} style={{ color: 'var(--ink-soft)', marginTop: 4 }}>{changeText(c)}</div>
                    ))}
                  </div>
                )
              })}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
