// =============================================================================
// Foray — Admin Seed Page
// Route: /admin/seed (only accessible by admin/gm role users)
// Purpose: One-click seeding of challenges into Firestore
// =============================================================================

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { collection, doc, setDoc, getDocs } from "firebase/firestore";
import { db, auth } from "../lib/firebase"; // adjust path to your firebase config
import { challengeSeedData, getChallengeStats } from "../data/challengeSeedData";

export default function AdminSeed() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<"idle" | "seeding" | "done" | "error">("idle");
  const [log, setLog] = useState<string[]>([]);
  const [existingCount, setExistingCount] = useState<number | null>(null);

  const addLog = (msg: string) => {
    setLog((prev) => [...prev, new Date().toLocaleTimeString() + " — " + msg]);
  };

  const checkExisting = async () => {
    try {
      const snapshot = await getDocs(collection(db, "challenges"));
      setExistingCount(snapshot.size);
      addLog("Found " + snapshot.size + " existing challenges in Firestore.");
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
        addLog("FAILED: " + challenge.id + " (" + challenge.title + ") — " + (err as Error).message);
      }
    }

    addLog("Done! " + success + " seeded, " + failed + " failed.");
    setStatus("done");
    setExistingCount(success);
  };

  const stats = getChallengeStats();

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
        <p style={{ color: "var(--ink-muted)", marginBottom: 24, fontSize: "0.9rem" }}>
          Push all {stats.total} challenges into Firestore. Safe to run multiple times — uses set (upsert).
        </p>

        {/* Top-level stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
          {[
            { label: "Total", value: stats.total, color: "var(--marigold)" },
            { label: "Easy", value: stats.byDifficulty.easy, color: "var(--green)" },
            { label: "Medium", value: stats.byDifficulty.medium, color: "var(--marigold)" },
            { label: "Hard", value: stats.byDifficulty.hard, color: "var(--red)" },
          ].map((s) => (
            <div key={s.label} style={{ background: "rgba(var(--ink-rgb), 0.03)", border: "1px solid var(--line)", borderRadius: 8, padding: 12, textAlign: "center" }}>
              <p style={{ fontSize: "1.3rem", fontWeight: 700, color: s.color }}>{s.value}</p>
              <p style={{ fontSize: "0.72rem", color: "var(--ink-muted)" }}>{s.label}</p>
            </div>
          ))}
        </div>

        {/* Category breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 24 }}>
          {[
            { label: "Humor", value: stats.byCategory.humor, color: "var(--pink)" },
            { label: "Culture", value: stats.byCategory.culture, color: "var(--blue)" },
            { label: "Exploration", value: stats.byCategory.exploration, color: "var(--green)" },
            { label: "Food", value: stats.byCategory.food, color: "#F77F00" },
            { label: "Fitness", value: stats.byCategory.fitness, color: "var(--red)" },
            { label: "Civic", value: stats.byCategory.civic, color: "var(--marigold)" },
            { label: "Art", value: stats.byCategory.art, color: "var(--pink)" },
            { label: "Interact", value: stats.requiresInteraction, color: "var(--blue)" },
          ].map((s) => (
            <div key={s.label} style={{ background: "rgba(var(--ink-rgb), 0.03)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
              <p style={{ fontSize: "1rem", fontWeight: 700, color: s.color }}>{s.value}</p>
              <p style={{ fontSize: "0.68rem", color: "var(--ink-faint)" }}>{s.label}</p>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          <button onClick={checkExisting} style={{ background: "rgba(var(--ink-rgb), 0.05)", border: "1px solid var(--line-strong)", color: "var(--ink-soft)", padding: "10px 20px", borderRadius: 8, cursor: "pointer", fontSize: "0.88rem", fontFamily: "inherit" }}>
            Check Existing
          </button>
          <button onClick={seedChallenges} disabled={status === "seeding"} style={{ background: status === "done" ? "rgba(var(--green-rgb), 0.2)" : "rgba(var(--marigold-rgb), 0.15)", border: "1px solid " + (status === "done" ? "#06D6A040" : "#FFD16640"), color: status === "done" ? "var(--green)" : "var(--marigold)", padding: "10px 20px", borderRadius: 8, cursor: status === "seeding" ? "not-allowed" : "pointer", fontSize: "0.88rem", fontWeight: 600, fontFamily: "inherit" }}>
            {status === "seeding" ? "Seeding..." : status === "done" ? "Done! Re-seed?" : "Seed All Challenges"}
          </button>
        </div>

        {existingCount !== null && (
          <p style={{ color: "var(--ink-muted)", fontSize: "0.85rem", marginBottom: 16 }}>
            Firestore currently has <strong style={{ color: "var(--ink)" }}>{existingCount}</strong> challenge documents.
          </p>
        )}

        {/* Additional stats */}
        <div style={{ marginBottom: 24, padding: 16, background: "rgba(var(--ink-rgb), 0.02)", borderRadius: 8, border: "1px solid var(--line)", fontSize: "0.85rem", color: "var(--ink-muted)", display: "grid", gap: 6 }}>
          <div>{stats.withTier2} have tier 2 bonuses</div>
          <div>{stats.timeBased} are time-based (GM compares across teams)</div>
          <div>{stats.requiresMoney} require spending money</div>
          <div>{stats.requiresInteraction} require talking to strangers</div>
          <div>{stats.needsTeammate} require 2+ players</div>
        </div>

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