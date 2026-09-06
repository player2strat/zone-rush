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
    <div style={{ minHeight: "100vh", background: "#FDFFF1", color: "#202122", fontFamily: "'Helvetica Neue', Helvetica, Arial, sans-serif", padding: 24 }}>
      <div style={{ maxWidth: 600, margin: "0 auto" }}>
        <button
          onClick={() => navigate('/')}
          style={{ background: 'none', border: 'none', color: '#6F6E66', cursor: 'pointer', fontFamily: 'inherit', fontSize: '0.85rem', padding: 0, marginBottom: 12 }}
        >
          ← Home
        </button>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, marginBottom: 8 }}>Admin: Seed Challenges</h1>
        <p style={{ color: "#55544E", marginBottom: 24, fontSize: "0.9rem" }}>
          Push all {stats.total} challenges into Firestore. Safe to run multiple times — uses set (upsert).
        </p>

        {/* Top-level stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 16 }}>
          {[
            { label: "Total", value: stats.total, color: "#FFD626" },
            { label: "Easy", value: stats.byDifficulty.easy, color: "#28B770" },
            { label: "Medium", value: stats.byDifficulty.medium, color: "#FFD626" },
            { label: "Hard", value: stats.byDifficulty.hard, color: "#FF4443" },
          ].map((s) => (
            <div key={s.label} style={{ background: "rgba(32,33,34,0.03)", border: "1px solid #E6E5DA", borderRadius: 8, padding: 12, textAlign: "center" }}>
              <p style={{ fontSize: "1.3rem", fontWeight: 700, color: s.color }}>{s.value}</p>
              <p style={{ fontSize: "0.72rem", color: "#5F5E57" }}>{s.label}</p>
            </div>
          ))}
        </div>

        {/* Category breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 24 }}>
          {[
            { label: "Humor", value: stats.byCategory.humor, color: "#E67DD1" },
            { label: "Culture", value: stats.byCategory.culture, color: "#1EB2F2" },
            { label: "Exploration", value: stats.byCategory.exploration, color: "#28B770" },
            { label: "Food", value: stats.byCategory.food, color: "#F77F00" },
            { label: "Fitness", value: stats.byCategory.fitness, color: "#FF4443" },
            { label: "Civic", value: stats.byCategory.civic, color: "#FFD626" },
            { label: "Art", value: stats.byCategory.art, color: "#E67DD1" },
            { label: "Interact", value: stats.requiresInteraction, color: "#1EB2F2" },
          ].map((s) => (
            <div key={s.label} style={{ background: "rgba(32,33,34,0.03)", border: "1px solid #E6E5DA", borderRadius: 8, padding: "8px 12px", textAlign: "center" }}>
              <p style={{ fontSize: "1rem", fontWeight: 700, color: s.color }}>{s.value}</p>
              <p style={{ fontSize: "0.68rem", color: "#6F6E66" }}>{s.label}</p>
            </div>
          ))}
        </div>

        {/* Action buttons */}
        <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
          <button onClick={checkExisting} style={{ background: "rgba(32,33,34,0.05)", border: "1px solid #D6D5CA", color: "#3A3935", padding: "10px 20px", borderRadius: 8, cursor: "pointer", fontSize: "0.88rem", fontFamily: "inherit" }}>
            Check Existing
          </button>
          <button onClick={seedChallenges} disabled={status === "seeding"} style={{ background: status === "done" ? "rgba(40,183,112,0.2)" : "rgba(255,214,38,0.15)", border: "1px solid " + (status === "done" ? "#06D6A040" : "#FFD16640"), color: status === "done" ? "#28B770" : "#FFD626", padding: "10px 20px", borderRadius: 8, cursor: status === "seeding" ? "not-allowed" : "pointer", fontSize: "0.88rem", fontWeight: 600, fontFamily: "inherit" }}>
            {status === "seeding" ? "Seeding..." : status === "done" ? "Done! Re-seed?" : "Seed All Challenges"}
          </button>
        </div>

        {existingCount !== null && (
          <p style={{ color: "#55544E", fontSize: "0.85rem", marginBottom: 16 }}>
            Firestore currently has <strong style={{ color: "#202122" }}>{existingCount}</strong> challenge documents.
          </p>
        )}

        {/* Additional stats */}
        <div style={{ marginBottom: 24, padding: 16, background: "rgba(32,33,34,0.02)", borderRadius: 8, border: "1px solid #E6E5DA", fontSize: "0.85rem", color: "#4A4944", display: "grid", gap: 6 }}>
          <div>{stats.withTier2} have tier 2 bonuses</div>
          <div>{stats.timeBased} are time-based (GM compares across teams)</div>
          <div>{stats.requiresMoney} require spending money</div>
          <div>{stats.requiresInteraction} require talking to strangers</div>
          <div>{stats.needsTeammate} require 2+ players</div>
        </div>

        {/* Log output */}
        {log.length > 0 && (
          <div style={{ background: "#FFFFFF", border: "1px solid #E6E5DA", borderRadius: 8, padding: 16, maxHeight: 300, overflowY: "auto", fontFamily: "'Martian Mono', monospace", fontSize: "0.78rem", lineHeight: 1.8 }}>
            {log.map((line, i) => (
              <div key={i} style={{ color: line.includes("ERROR") || line.includes("FAILED") ? "#FF4443" : line.includes("Done!") ? "#28B770" : "#55544E" }}>
                {line}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}