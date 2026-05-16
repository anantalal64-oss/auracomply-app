// netlify/functions/validate-pa.js
// AuraComply AI — PA Validation Engine v3.0
// Model: claude-haiku-4-5-20251001 (fast + cheap — correct for validation tasks)
// Auth:  Netlify Identity JWT → context.clientContext.user
//
// KEY BUG FIXED FROM v2:
//   OLD stop_sequences: ["}}}"]  ← BROKEN — three closing braces never appear
//   NEW stop_sequences: ["```"]  ← correct: stops Claude adding markdown after JSON
//
// PAYER_CAPS imported from same source-of-truth as generate-pa.js.
// Any cap change goes in generate-pa.js PAYER_RULES — validate-pa.js
// mirrors it via PAYER_CAPS below (kept in sync by hand or a shared module).

"use strict";

const MODEL   = "claude-haiku-4-5-20251001";  // correct model string
const CLAUDE  = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

// ═══════════════════════════════════════════════════════════════════════════
// PAYER CAPS — mirrors PAYER_RULES in generate-pa.js
// Keep these in sync whenever you update generate-pa.js PAYER_RULES.
// ═══════════════════════════════════════════════════════════════════════════

const PAYER_CAPS = {
  medicaid: { dailyHourCap: 8, weeklyHourCap: 40, weeklyUnitCap: 40, requiresFBA: true, requiresMdOrder: false, diagnosisWindow: null  },
  anthem:   { dailyHourCap: 8, weeklyHourCap: 40, weeklyUnitCap: 40, requiresFBA: true, requiresMdOrder: false, diagnosisWindow: 36    },
  uhc:      { dailyHourCap: 8, weeklyHourCap: 30, weeklyUnitCap: 40, requiresFBA: true, requiresMdOrder: true,  diagnosisWindow: null  },
  bcbs:     { dailyHourCap: 8, weeklyHourCap: 40, weeklyUnitCap: 40, requiresFBA: true, requiresMdOrder: false, diagnosisWindow: 36    },
  aetna:    { dailyHourCap: 8, weeklyHourCap: 8,  weeklyUnitCap: 32, requiresFBA: true, requiresMdOrder: true,  diagnosisWindow: 24    },
  cigna:    { dailyHourCap: 8, weeklyHourCap: 40, weeklyUnitCap: 40, requiresFBA: true, requiresMdOrder: false, diagnosisWindow: 36    },
  molina:   { dailyHourCap: 8, weeklyHourCap: 40, weeklyUnitCap: 40, requiresFBA: true, requiresMdOrder: false, diagnosisWindow: null  },
};

// ═══════════════════════════════════════════════════════════════════════════
// SCORING — deterministic pre-score before hitting Claude
// Each deduction has a code so the frontend can show targeted help text.
// ═══════════════════════════════════════════════════════════════════════════

const DEDUCTIONS = {
  MUE_BREACH:        { points: 30, level: "error",   code: "MUE_001", label: "Hours exceed daily MUE cap" },
  PEER_REVIEW_RISK:  { points: 15, level: "warning",  code: "MUE_002", label: "Hours may trigger peer review" },
  MISSING_MD_ORDER:  { points: 20, level: "error",   code: "AUTH_001", label: "MD order required but not indicated" },
  DIAGNOSIS_EXPIRED: { points: 25, level: "error",   code: "DX_001",   label: "Diagnosis may be outside payer window" },
  MISSING_FBA:       { points: 20, level: "error",   code: "DOC_001",  label: "FBA required but not indicated in draft" },
  MISSING_VBMAPP:    { points: 10, level: "warning",  code: "DOC_002",  label: "VB-MAPP or ABLLS-R score missing" },
  MISSING_BCBA_CREDS:{ points: 25, level: "error",   code: "CRED_001", label: "BCBA name or license not present" },
  MISSING_BCBA_NPI:  { points: 15, level: "error",   code: "CRED_002", label: "BCBA NPI not present" },
  MISSING_HO_MOD:    { points: 20, level: "error",   code: "MOD_001",  label: "HO modifier missing for 97155/97156" },
  MISSING_GOALS:     { points: 15, level: "warning",  code: "PLAN_001", label: "Treatment goals not found in draft" },
  MISSING_IMPAIRMENTS:{ points:10, level: "warning", code: "PLAN_002", label: "Functional impairments section sparse" },
};

function scoreToRiskLabel(score) {
  if (score >= 80) return "Low";
  if (score >= 55) return "Medium";
  return "High";
}

// ── Deterministic pre-score (fast, no API call) ──────────────────────────

function preScore(draft, payer, hoursPerWeek, diagnosisDateStr) {
  const payerKey = (payer || "medicaid").toLowerCase();
  const caps     = PAYER_CAPS[payerKey] || PAYER_CAPS.medicaid;

  let score       = 100;
  const errors    = [];
  const warnings  = [];
  const flags     = [];     // machine-readable for frontend

  const text = (draft || "").toLowerCase();
  const hrs  = parseFloat(hoursPerWeek) || 0;

  // ── MUE / daily cap ──────────────────────────────────────────────────
  const hrsPerDay = hrs / 5;
  if (hrsPerDay > caps.dailyHourCap) {
    score -= DEDUCTIONS.MUE_BREACH.points;
    errors.push(`Requested ${hrs} hrs/week = ${hrsPerDay.toFixed(1)} hrs/day — exceeds ${caps.dailyHourCap} hr/day MUE cap for ${payerKey.toUpperCase()}.`);
    flags.push(DEDUCTIONS.MUE_BREACH);
  } else if (hrs > caps.weeklyHourCap) {
    score -= DEDUCTIONS.PEER_REVIEW_RISK.points;
    warnings.push(`${hrs} hrs/week may trigger peer review for ${payerKey.toUpperCase()} (threshold: ${caps.weeklyHourCap} hrs/week).`);
    flags.push(DEDUCTIONS.PEER_REVIEW_RISK);
  }

  // ── MD order requirement ─────────────────────────────────────────────
  if (caps.requiresMdOrder) {
    const hasMdEvidence = text.includes("physician") || text.includes("md order") || text.includes("do order");
    if (!hasMdEvidence) {
      score -= DEDUCTIONS.MISSING_MD_ORDER.points;
      errors.push(`${payerKey.toUpperCase()} requires an active MD/DO order for 97155. Not detected in draft.`);
      flags.push(DEDUCTIONS.MISSING_MD_ORDER);
    }
  }

  // ── Diagnosis window ─────────────────────────────────────────────────
  if (caps.diagnosisWindow && diagnosisDateStr) {
    try {
      const dxDate     = new Date(diagnosisDateStr);
      const monthsAgo  = (Date.now() - dxDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      if (monthsAgo > caps.diagnosisWindow) {
        score -= DEDUCTIONS.DIAGNOSIS_EXPIRED.points;
        errors.push(`Diagnosis date (${diagnosisDateStr}) is ${Math.round(monthsAgo)} months ago. ${payerKey.toUpperCase()} requires diagnosis within ${caps.diagnosisWindow} months.`);
        flags.push(DEDUCTIONS.DIAGNOSIS_EXPIRED);
      }
    } catch { /* ignore bad date */ }
  }

  // ── FBA ─────────────────────────────────────────────────────────────
  if (caps.requiresFBA && !text.includes("fba") && !text.includes("functional behavior")) {
    score -= DEDUCTIONS.MISSING_FBA.points;
    errors.push("FBA (Functional Behavior Assessment) required but not mentioned in draft.");
    flags.push(DEDUCTIONS.MISSING_FBA);
  }

  // ── VB-MAPP / ABLLS-R ───────────────────────────────────────────────
  if (!text.includes("vb-mapp") && !text.includes("vbmapp") && !text.includes("ablls")) {
    score -= DEDUCTIONS.MISSING_VBMAPP.points;
    warnings.push("VB-MAPP or ABLLS-R score not detected in draft — payers require standardized assessment scores.");
    flags.push(DEDUCTIONS.MISSING_VBMAPP);
  }

  // ── BCBA credentials ────────────────────────────────────────────────
  const hasBCBAName = text.includes("bcba") && (text.includes("license") || text.includes("lba"));
  if (!hasBCBAName) {
    score -= DEDUCTIONS.MISSING_BCBA_CREDS.points;
    errors.push("BCBA name and license number not detected. Required by all payers.");
    flags.push(DEDUCTIONS.MISSING_BCBA_CREDS);
  }

  if (!text.includes("npi")) {
    score -= DEDUCTIONS.MISSING_BCBA_NPI.points;
    errors.push("BCBA or clinic NPI not detected. Required on all PA forms.");
    flags.push(DEDUCTIONS.MISSING_BCBA_NPI);
  }

  // ── HO modifier ─────────────────────────────────────────────────────
  if ((text.includes("97155") || text.includes("97156")) && !text.includes("ho")) {
    score -= DEDUCTIONS.MISSING_HO_MOD.points;
    errors.push("HO modifier not detected for 97155/97156. Required for BCBA-level services.");
    flags.push(DEDUCTIONS.MISSING_HO_MOD);
  }

  // ── Treatment goals ─────────────────────────────────────────────────
  if (!text.includes("goal") && !text.includes("smart")) {
    score -= DEDUCTIONS.MISSING_GOALS.points;
    warnings.push("SMART treatment goals not detected. All payers require measurable goals with baseline data.");
    flags.push(DEDUCTIONS.MISSING_GOALS);
  }

  // ── Functional impairments ──────────────────────────────────────────
  const impairmentKeywords = ["communication", "social", "daily living", "adl", "safety", "behavior"];
  const impairmentHits = impairmentKeywords.filter(k => text.includes(k)).length;
  if (impairmentHits < 2) {
    score -= DEDUCTIONS.MISSING_IMPAIRMENTS.points;
    warnings.push("Functional impairment narrative is sparse. Add specific deficits with percentage/numeric evidence.");
    flags.push(DEDUCTIONS.MISSING_IMPAIRMENTS);
  }

  return {
    preScore:   Math.max(0, score),
    errors,
    warnings,
    flags,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SYSTEM PROMPT — instructs Claude to validate beyond the pre-score
// ═══════════════════════════════════════════════════════════════════════════

const VALIDATOR_SYSTEM = `You are a senior ABA billing compliance specialist and prior authorization auditor.
Your job is to find issues in PA drafts that cause denials.

Review the PA draft and return ONLY valid JSON — no markdown, no preamble, no explanation.

Check specifically for:
- CPT code validity for ABA therapy (valid: 97153, 97154, 97155, 97156, 97157, 97158)
- Unit limits per payer — flag if exceeding 8 hours/day (32 units) combined
- Diagnosis-to-CPT alignment (F84.x ICD-10 required for ABA codes)
- Missing BCBA credentials, license, and NPI
- Wrong or missing modifiers: HO (BCBA level), 95 (telehealth), GT (Medicaid telehealth), HN (bachelor)
- Vague medical necessity — must include specific assessment scores and functional deficits with percentages
- Missing or non-SMART treatment goals (goals need baseline, target, timeline, method)
- Missing assessment scores (VB-MAPP levels, ABLLS-R domains, Vineland adaptive scores)
- Missing or thin family-training narrative for 97156 and 97157
- Missing signature placeholders for BCBA and supervising physician
- Section 9 LMN bullets not using Proof Triplet format (Assessment → Loss → LRE justification)
- Section 10 pre-submission checklist incomplete or missing critical items
- Diagnosis date outside payer window

Return EXACTLY this JSON — all keys required, no extra keys, no nested markdown:
{
  "ready": true,
  "score": 85,
  "denialRiskLabel": "Low",
  "errors": ["critical issue requiring fix before submission"],
  "warnings": ["minor issues that may increase denial risk"],
  "suggestions": ["improvements to strengthen the PA"]
}

Rules:
- "ready" = true only if score >= 80 AND errors array is empty
- "score" = integer 0–100
- "denialRiskLabel" = "Low" (>=80), "Medium" (55–79), or "High" (<55)
- Each array item is a specific, actionable string — not vague
- Maximum 6 errors, 4 warnings, 4 suggestions`;

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════════════

const callClaude = async (draft, payer, state) => {
  const userPrompt =
    `Validate this ${payer || "Medicaid"} PA draft for ${state || "unknown state"}. ` +
    `Return JSON only — no markdown:\n\n${draft}`;

  const messages = [
    { role: "user",      content: userPrompt },
    // Prefill: forces Claude to start the JSON object immediately
    { role: "assistant", content: "{" },
  ];

  const res = await fetch(CLAUDE, {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         process.env.ANTHROPIC_API_KEY,
      "anthropic-version": VERSION,
    },
    body: JSON.stringify({
      model:          MODEL,
      max_tokens:     1024,
      system:         VALIDATOR_SYSTEM,
      messages,
      // FIX: was ["}}}"] which NEVER triggered — JSON never has 3 consecutive }
      // CORRECT: "```" stops Claude from appending markdown after the JSON object
      stop_sequences: ["```"],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  // Re-attach the "{" from the prefill that Claude continued from
  return "{" + (data?.content?.[0]?.text || "").trim();
};

// ═══════════════════════════════════════════════════════════════════════════
// JSON PARSER — same robust parser as generate-pa.js
// ═══════════════════════════════════════════════════════════════════════════

const safeParseJSON = (text) => {
  try {
    const cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/,      "")
      .replace(/```\s*$/,      "")
      .trim();
    const start = cleaned.indexOf("{");
    const end   = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found");
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// RESULT MERGER — combines deterministic pre-score with Claude's audit
// Deduplicates errors, preserves severity, recalculates final score.
// ═══════════════════════════════════════════════════════════════════════════

const mergeResults = (pre, claudeResult) => {
  // Combine errors/warnings, dedup by first 60 chars
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(item => {
      const key = item.slice(0, 60).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  const errors      = dedup([...pre.errors,   ...(claudeResult.errors   || [])]);
  const warnings    = dedup([...pre.warnings,  ...(claudeResult.warnings || [])]);
  const suggestions = dedup(claudeResult.suggestions || []);

  // Final score: weighted average — pre-score has higher fidelity on structure rules
  // Claude score has higher fidelity on clinical-language quality
  const claudeScore = typeof claudeResult.score === "number" ? claudeResult.score : 70;
  const finalScore  = Math.round((pre.preScore * 0.5) + (claudeScore * 0.5));

  return {
    ready:          errors.length === 0 && finalScore >= 80,
    score:          finalScore,
    preScore:       pre.preScore,
    claudeScore,
    denialRiskLabel:scoreToRiskLabel(finalScore),
    errors,
    warnings,
    suggestions,
    flags:          pre.flags,   // machine-readable codes for frontend help text
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export default async (req, context) => {

  // ── 1. Method guard ────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── 2. Auth guard (Netlify Identity) ───────────────────────────────────
  // Netlify validates the Bearer JWT from Authorization header
  // and populates context.clientContext.user automatically.
  // Frontend must pass: Authorization: Bearer <netlifyIdentity.currentUser().token.access_token>
  const netlifyUser = context?.clientContext?.user;
  if (!netlifyUser) {
    return Response.json(
      { error: "Unauthorized. Please sign in.", status: "auth_error" },
      { status: 401 }
    );
  }

  const userEmail = netlifyUser.email || "unknown";

  // ── 3. Request ID ─────────────────────────────────────────────────────
  const requestId = `val-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {

    // ── 4. Parse body ─────────────────────────────────────────────────────
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON body", status: "validation_error", requestId },
        { status: 400 }
      );
    }

    const { draft, payer, state, hoursPerWeek, diagnosisDate } = body;

    if (!draft || typeof draft !== "string" || draft.trim().length < 50) {
      return Response.json({
        ready:          false,
        score:          0,
        denialRiskLabel:"High",
        errors:         ["No PA draft provided or draft is too short to validate."],
        warnings:       [],
        suggestions:    ["Generate a full draft using the PA generator first."],
        requestId,
      }, { status: 400 });
    }

    // ── 5. Deterministic pre-score ─────────────────────────────────────
    const pre = preScore(draft, payer, hoursPerWeek, diagnosisDate);

    // ── 6. Claude validation ─────────────────────────────────────────────
    let claudeResult;
    try {
      const rawText    = await callClaude(draft, payer, state);
      const parsed     = safeParseJSON(rawText);
      claudeResult     = parsed || {
        score:          50,
        errors:         ["Could not parse Claude validation — review manually."],
        warnings:       [],
        suggestions:    ["Ensure all 11 sections are complete before revalidating."],
      };
    } catch (claudeErr) {
      console.error(`[validate-pa] Claude call failed: ${claudeErr.message}`);
      // Degrade gracefully — return pre-score only
      claudeResult = {
        score:       pre.preScore,
        errors:      [],
        warnings:    ["Claude validation unavailable — showing structural checks only."],
        suggestions: [],
      };
    }

    // ── 7. Merge and return final result ──────────────────────────────────
    const result = mergeResults(pre, claudeResult);

    console.log(`[validate-pa] requestId=${requestId} user=${userEmail} score=${result.score} risk=${result.denialRiskLabel}`);

    return Response.json({
      ...result,
      requestId,
      validatedBy:  userEmail,
      validatedAt:  new Date().toISOString(),
      payer:        payer || "unknown",
      state:        state || "unknown",
    });

  } catch (err) {
    console.error(`[validate-pa] requestId=${requestId} user=${userEmail} error=${err.message}`);
    return Response.json({
      ready:          false,
      score:          0,
      denialRiskLabel:"High",
      errors:         ["Validation service error. Please retry."],
      warnings:       [],
      suggestions:    [],
      detail:         err.message,
      requestId,
    }, { status: 500 });
  }
};

export const config = { path: "/api/validate-pa" };