// =============================================================================
// Foray — Admin Seed Page
// Route: /admin/seed (only accessible by admin/gm role users)
// Purpose: One-click seeding of challenges into Firestore
//
// The cards count every challenge in Firestore (what games deal from), which
// can be more than the seed file holds. Seeding only adds or overwrites the
// seed file's challenges; it never removes the others.
// =============================================================================

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, doc, setDoc, getDocs } from "firebase/firestore";
import { db, auth } from "../lib/firebase"; // adjust path to your firebase config
import { challengeSeedData, getChallengeStats } from "../data/challengeSeedData";
import { countChallenges, type ChallengeCounts } from "../lib/challengeStats";

const CARD_COLOR: Record<string, string> = {
  total: "var(--marigold)",
  easy: "var(--green)",
  medium: "var(--marigold)",
  hard: "var(--red)",
  humor: "var(--pink)",
  culture: "var(--blue)",
  exploration: "var(--green)",
  food: "#F77F00",
  fitness: "var(--red)",
  civic: "var(--marigold)",
  art: "var(--pink)",
};

async function loadChallengeCounts(): Promise<ChallengeCounts> {
  const snapshot = await getDocs(collection(db, "challenges"));
  return countChallenges(snapshot.docs.map((d) => d.data()));
}

export default function AdminSeed() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"idle" | "seeding" | "done" | "error">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [counts, setCounts] = useState<ChallengeCounts | null>(null);
  const [countError, setCountError] = useState<string | null>(null);

  const addLog = (msg: string) => {
    setLog((prev) => [...prev, new Date().toLocaleTimeString() + " · " + msg]);
  };

  // Count what's in Firestore as soon as the page opens.
  useEffect(() => {
    let cancelled = false;
    loadChallengeCounts()
      .then((c) => { if (!cancelled) setCounts(c); })
      .catch((err) => { if (!cancelled) setCountError((err as Error).message); });
    return () => { cancelled = true; };
  }, []);

  const checkExisting = async () => {
    try {
      const c = await loadChallengeCounts();
      setCounts(c);
      setCountError(null);
      addLog("Found " + c.total + " existing challenges in Firestore.");
    } catch (err) {
      addLog("Error checking existing: " + (err as Error).message);
    }
  };

  const seedChallenges = async () => {
    setStatus("seeding");
    addLog("Starting challenge seed...");

    const user = auth.currentUser;
    if (!user) {
      addLog("ERROR: Not logged in. Please log in first.");
      setStatus("error");
      return;
    }

    const stats = getChallengeStats();
    addLog("Seeding " + stats.total + " challenges (" + stats.byDifficulty.easy + " easy, " + stats.byDifficulty.medium + " medium, " + stats.byDifficulty.hard + " hard)");

    let success = 0;
    let failed = 0;

    for (const challenge of challengeSeedData) {
      try {
        const docRef = doc(db, "challenges", challenge.id);
        await setDoc(docRef, {
          ...challenge,
          created_by: user.uid,
          created_at: new Date(),
        });
        success++;
        if (success % 10 === 0) {
          addLog("...seeded " + success + "/" + stats.total);
        }
      } catch (err) {
        failed++;
        addLog("FAILED: " + challenge.id + " (" + challenge.title + "): " + (err as Error).message);
      }
    }

    addLog("Done! " + success + " seeded, " + failed + " failed.");
    setStatus("done");
    await checkExisting();
  };

  const seedTotal = challengeSeedData.length;

  return (
    <div style={{ minHeight: "100vh", background: "var(--paper)", color: "var(--ink)", fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", padding: 24 }}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: 'var(--ink-faint)', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}
        >
          ← Home
        </button>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: 8 }}>Admin: Seed Challenges</h1>
        <p style={{ color: "var(--ink-muted)", marginBottom: 24, fontSize: "0.9rem", lineHeight: 1.5 }}>
          The cards count every challenge in Firestore. "Seed All Challenges" adds the {seedTotal} challenges
          in the seed file, overwriting any that are already there, and leaves all other challenges alone.
        </p>

        {countError ? (
          <p style={{ color: "var(--red)", fontSize: "0.85rem", marginBottom: 24 }}>Couldn't count challenges: {countError}</p>
        ) : !counts ? (
          <p style={{ color: "var(--ink-faint)", fontSize: "0.85rem", marginBottom: 24 }}>Counting challenges in Firestore…</p>
        ) : (
          <>
            {/* Total and difficulty (adds up to Total) */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(" + (counts.byDifficulty.length + 1) + ", 1fr)", gap: 8, marginBottom: 16 }}>
              {[{ key: "total", label: "Total", count: counts.total }, ...counts.byDifficulty].map((s) => (
                <div key={s.key} style={{ background: "rgba(var(--ink-rgb), 0.03)", border: "1px solid var(--line)", borderRadius: 8, padding: 12, textAlign: "center" }}>
                  <p style={{ fontSize: "1.3rem", fontWeight: 700, color: CARD_COLOR[s.key] ?? "var(--ink-soft)" }}>{s.count}</p>
                  <p style={{ fontSize: "0.72rem", color: "var(--ink-muted)" }}>{s.label}</p>
                </div>
              ))}
            </div>

            {/* Category breakdown (adds up to Total) */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 24 }}>
              {counts.byCategory.map((s) => (
                <div key={s.key} style={{ background: "rgba(var(--ink-rgb), 0.03)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
                  <p style={{ fontSize: "1rem", fontWeight: 700, color: CARD_COLOR[s.key] ?? "var(--ink-soft)" }}>{s.count}</p>
                  <p style={{ fontSize: "0.68rem", color: "var(--ink-faint)" }}>{s.label}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          <button onClick={checkExisting} style={{ background: "rgba(var(--ink-rgb), 0.05)", border: "1px solid var(--line-strong)", color: "var(--ink-soft)", padding: "10px 20px", borderRadius: 8, cursor: "pointer", fontSize: "0.88rem", fontFamily: "inherit" }}>
            Check Existing
          </button>
          <button onClick={seedChallenges} disabled={status === "seeding"} style={{ background: status === "done" ? "rgba(var(--green-rgb), 0.2)" : "rgba(var(--marigold-rgb), 0.15)", border: "1px solid " + (status === "done" ? "#06D6A040" : "#FFD16640"), color: status === "done" ? "var(--green)" : "var(--marigold)", padding: "10px 20px", borderRadius: 8, cursor: status === "seeding" ? "not-allowed" : "pointer", fontSize: "0.88rem", fontWeight: 600, fontFamily: "inherit" }}>
            {status === "seeding" ? "Seeding..." : status === "done" ? "Done! Re-seed?" : "Seed All Challenges"}
          </button>
        </div>

        {/* Additional stats */}
        {counts && (
          <div style={{ marginBottom: 24, padding: 16, background: "rgba(var(--ink-rgb), 0.02)", borderRadius: 8, border: "1px solid var(--line)", fontSize: "0.85rem", color: "var(--ink-muted)", display: "grid", gap: 6 }}>
            <div>{counts.active} are active (only these get dealt in games)</div>
            <div>{counts.withTier2} have tier 2 bonuses</div>
            <div>{counts.timeBased} are time-based (GM compares across teams)</div>
            <div>{counts.requiresMoney} require spending money</div>
            <div>{counts.requiresInteraction} require talking to strangers</div>
            <div>{counts.needsTeammate} require 2+ players</div>
          </div>
        )}

        {/* Log output */}
        {log.length > 0 && (
          <div style={{ background: "var(--surface)", border: "1px solid var(--line)", borderRadius: 8, padding: 16, maxHeight: 300, overflowY: "auto", fontFamily: "'Martian Mono', monospace", fontSize: "0.78rem", lineHeight: 1.8 }}>
            {log.map((line, i) => (
              <div key={i} style={{ color: line.includes("ERROR") || line.includes("FAILED") ? "var(--red)" : line.includes("Done!") ? "var(--green)" : "var(--ink-muted)" }}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
