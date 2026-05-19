// netlify/functions/validate-pa.js
// AuraComply AI — PA Validation Engine v3.1
// CONVERTED: ESM export default → CommonJS exports.handler
// REASON: Netlify could not parse ESM functions (showed "/" in dashboard, empty logs)
// CHANGES FROM v3.0:
//   [FIX 1] exports.handler instead of export default
//   [FIX 2] JSON.parse(event.body) instead of req.json()
//   [FIX 3] Added DEV_MODE bypass (was missing — caused 401 on all validate calls)
//   [FIX 4] Null-safe userEmail

"use strict";

const MODEL   = "claude-haiku-4-5-20251001";
const CLAUDE  = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

const CORS_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ═══════════════════════════════════════════════════════════════════════════
// PAYER CAPS
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
// SCORING
// ═══════════════════════════════════════════════════════════════════════════

const DEDUCTIONS = {
  MUE_BREACH:         { points: 30, level: "error",   code: "MUE_001",  label: "Hours exceed daily MUE cap" },
  PEER_REVIEW_RISK:   { points: 15, level: "warning",  code: "MUE_002",  label: "Hours may trigger peer review" },
  MISSING_MD_ORDER:   { points: 20, level: "error",   code: "AUTH_001", label: "MD order required but not indicated" },
  DIAGNOSIS_EXPIRED:  { points: 25, level: "error",   code: "DX_001",   label: "Diagnosis may be outside payer window" },
  MISSING_FBA:        { points: 20, level: "error",   code: "DOC_001",  label: "FBA required but not indicated in draft" },
  MISSING_VBMAPP:     { points: 10, level: "warning",  code: "DOC_002",  label: "VB-MAPP or ABLLS-R score missing" },
  MISSING_BCBA_CREDS: { points: 25, level: "error",   code: "CRED_001", label: "BCBA name or license not present" },
  MISSING_BCBA_NPI:   { points: 15, level: "error",   code: "CRED_002", label: "BCBA NPI not present" },
  MISSING_HO_MOD:     { points: 20, level: "error",   code: "MOD_001",  label: "HO modifier missing for 97155/97156" },
  MISSING_GOALS:      { points: 15, level: "warning",  code: "PLAN_001", label: "Treatment goals not found in draft" },
  MISSING_IMPAIRMENTS:{ points: 10, level: "warning",  code: "PLAN_002", label: "Functional impairments section sparse" },
};

function scoreToRiskLabel(score) {
  if (score >= 80) return "Low";
  if (score >= 55) return "Medium";
  return "High";
}

function preScore(draft, payer, hoursPerWeek, diagnosisDateStr) {
  var payerKey = (payer || "medicaid").toLowerCase();
  var caps     = PAYER_CAPS[payerKey] || PAYER_CAPS.medicaid;

  var score    = 100;
  var errors   = [];
  var warnings = [];
  var flags    = [];
  var text     = (draft || "").toLowerCase();
  var hrs      = parseFloat(hoursPerWeek) || 0;

  var hrsPerDay = hrs / 5;
  if (hrsPerDay > caps.dailyHourCap) {
    score -= DEDUCTIONS.MUE_BREACH.points;
    errors.push("Requested " + hrs + " hrs/week = " + hrsPerDay.toFixed(1) + " hrs/day — exceeds " + caps.dailyHourCap + " hr/day MUE cap for " + payerKey.toUpperCase() + ".");
    flags.push(DEDUCTIONS.MUE_BREACH);
  } else if (hrs > caps.weeklyHourCap) {
    score -= DEDUCTIONS.PEER_REVIEW_RISK.points;
    warnings.push(hrs + " hrs/week may trigger peer review for " + payerKey.toUpperCase() + " (threshold: " + caps.weeklyHourCap + " hrs/week).");
    flags.push(DEDUCTIONS.PEER_REVIEW_RISK);
  }

  if (caps.requiresMdOrder) {
    if (!text.includes("physician") && !text.includes("md order") && !text.includes("do order")) {
      score -= DEDUCTIONS.MISSING_MD_ORDER.points;
      errors.push(payerKey.toUpperCase() + " requires an active MD/DO order for 97155. Not detected in draft.");
      flags.push(DEDUCTIONS.MISSING_MD_ORDER);
    }
  }

  if (caps.diagnosisWindow && diagnosisDateStr) {
    try {
      var dxDate    = new Date(diagnosisDateStr);
      var monthsAgo = (Date.now() - dxDate.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
      if (monthsAgo > caps.diagnosisWindow) {
        score -= DEDUCTIONS.DIAGNOSIS_EXPIRED.points;
        errors.push("Diagnosis date (" + diagnosisDateStr + ") is " + Math.round(monthsAgo) + " months ago. " + payerKey.toUpperCase() + " requires diagnosis within " + caps.diagnosisWindow + " months.");
        flags.push(DEDUCTIONS.DIAGNOSIS_EXPIRED);
      }
    } catch (e) { /* ignore bad date */ }
  }

  if (caps.requiresFBA && !text.includes("fba") && !text.includes("functional behavior")) {
    score -= DEDUCTIONS.MISSING_FBA.points;
    errors.push("FBA (Functional Behavior Assessment) required but not mentioned in draft.");
    flags.push(DEDUCTIONS.MISSING_FBA);
  }

  if (!text.includes("vb-mapp") && !text.includes("vbmapp") && !text.includes("ablls")) {
    score -= DEDUCTIONS.MISSING_VBMAPP.points;
    warnings.push("VB-MAPP or ABLLS-R score not detected in draft — payers require standardized assessment scores.");
    flags.push(DEDUCTIONS.MISSING_VBMAPP);
  }

  var hasBCBAName = text.includes("bcba") && (text.includes("license") || text.includes("lba"));
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

  if ((text.includes("97155") || text.includes("97156")) && !text.includes("ho")) {
    score -= DEDUCTIONS.MISSING_HO_MOD.points;
    errors.push("HO modifier not detected for 97155/97156. Required for BCBA-level services.");
    flags.push(DEDUCTIONS.MISSING_HO_MOD);
  }

  if (!text.includes("goal") && !text.includes("smart")) {
    score -= DEDUCTIONS.MISSING_GOALS.points;
    warnings.push("SMART treatment goals not detected. All payers require measurable goals with baseline data.");
    flags.push(DEDUCTIONS.MISSING_GOALS);
  }

  var impairmentKeywords = ["communication", "social", "daily living", "adl", "safety", "behavior"];
  var impairmentHits = impairmentKeywords.filter(function(k) { return text.includes(k); }).length;
  if (impairmentHits < 2) {
    score -= DEDUCTIONS.MISSING_IMPAIRMENTS.points;
    warnings.push("Functional impairment narrative is sparse. Add specific deficits with percentage/numeric evidence.");
    flags.push(DEDUCTIONS.MISSING_IMPAIRMENTS);
  }

  return { preScore: Math.max(0, score), errors: errors, warnings: warnings, flags: flags };
}

// ═══════════════════════════════════════════════════════════════════════════
// VALIDATOR SYSTEM PROMPT
// ═══════════════════════════════════════════════════════════════════════════

const VALIDATOR_SYSTEM = `You are a senior ABA billing compliance specialist and prior authorization auditor.
Your job is to find issues in PA drafts that cause denials.

Review the PA draft and return ONLY valid JSON — no markdown, no preamble, no explanation.

Return EXACTLY this JSON — all keys required:
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
- "score" = integer 0-100
- "denialRiskLabel" = "Low" (>=80), "Medium" (55-79), or "High" (<55)
- Each array item is a specific, actionable string
- Maximum 6 errors, 4 warnings, 4 suggestions`;

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE API CALL
// ═══════════════════════════════════════════════════════════════════════════

const callClaude = async function(draft, payer, state) {
  var userPrompt = "Validate this " + (payer || "Medicaid") + " PA draft for " + (state || "unknown state") + ". Return JSON only — no markdown:\n\n" + draft;

  var messages = [
    { role: "user",      content: userPrompt },
    { role: "assistant", content: "{" },
  ];

  var res = await fetch(CLAUDE, {
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
      messages:       messages,
      stop_sequences: ["```"],
    }),
  });

  if (!res.ok) {
    var errText = await res.text();
    throw new Error("Claude API " + res.status + ": " + errText.slice(0, 300));
  }

  var data = await res.json();
  return "{" + (data && data.content && data.content[0] ? data.content[0].text : "").trim();
};

// ═══════════════════════════════════════════════════════════════════════════
// JSON PARSER
// ═══════════════════════════════════════════════════════════════════════════

const safeParseJSON = function(text) {
  try {
    var cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/,      "")
      .replace(/```\s*$/,      "")
      .trim();
    var start = cleaned.indexOf("{");
    var end   = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON found");
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// RESULT MERGER
// ═══════════════════════════════════════════════════════════════════════════

const mergeResults = function(pre, claudeResult) {
  var dedup = function(arr) {
    var seen = {};
    return arr.filter(function(item) {
      var key = item.slice(0, 60).toLowerCase();
      if (seen[key]) return false;
      seen[key] = true;
      return true;
    });
  };

  var errors      = dedup(pre.errors.concat(claudeResult.errors   || []));
  var warnings    = dedup(pre.warnings.concat(claudeResult.warnings || []));
  var suggestions = dedup(claudeResult.suggestions || []);
  var claudeScore = typeof claudeResult.score === "number" ? claudeResult.score : 70;
  var finalScore  = Math.round((pre.preScore * 0.5) + (claudeScore * 0.5));

  return {
    ready:           errors.length === 0 && finalScore >= 80,
    score:           finalScore,
    preScore:        pre.preScore,
    claudeScore:     claudeScore,
    denialRiskLabel: scoreToRiskLabel(finalScore),
    errors:          errors,
    warnings:        warnings,
    suggestions:     suggestions,
    flags:           pre.flags,
  };
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER
// ═══════════════════════════════════════════════════════════════════════════

const respond = function(statusCode, data) {
  return { statusCode: statusCode, headers: CORS_HEADERS, body: JSON.stringify(data) };
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — CommonJS v1
// ═══════════════════════════════════════════════════════════════════════════

exports.handler = async function(event, context) {

  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  // Method guard
  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  // Auth guard — [FIX] Added DEV_MODE bypass (was missing in original)
  var DEV_MODE    = process.env.DEV_MODE === "true";
  var netlifyUser = context && context.clientContext && context.clientContext.user
    ? context.clientContext.user : null;

  if (!DEV_MODE && !netlifyUser) {
    return respond(401, { error: "Unauthorized. Please sign in.", status: "auth_error" });
  }

  // [FIX] Null-safe userEmail
  var userEmail = netlifyUser ? (netlifyUser.email || "unknown") : "dev-test@auracomply.ai";
  var requestId = "val-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  try {

    // Parse body
    var body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return respond(400, { error: "Invalid JSON body", status: "validation_error", requestId: requestId });
    }

    var draft         = body.draft;
    var payer         = body.payer;
    var state         = body.state;
    var hoursPerWeek  = body.hoursPerWeek;
    var diagnosisDate = body.diagnosisDate;

    if (!draft || typeof draft !== "string" || draft.trim().length < 50) {
      return respond(400, {
        ready: false, score: 0, denialRiskLabel: "High",
        errors: ["No PA draft provided or draft is too short to validate."],
        warnings: [], suggestions: ["Generate a full draft using the PA generator first."],
        requestId: requestId,
      });
    }

    // Deterministic pre-score
    var pre = preScore(draft, payer, hoursPerWeek, diagnosisDate);

    // Claude validation
    var claudeResult;
    try {
      var rawText  = await callClaude(draft, payer, state);
      var parsed   = safeParseJSON(rawText);
      claudeResult = parsed || {
        score: 50,
        errors: ["Could not parse Claude validation — review manually."],
        warnings: [], suggestions: ["Ensure all 11 sections are complete before revalidating."],
      };
    } catch (claudeErr) {
      console.error("[validate-pa] Claude call failed: " + claudeErr.message);
      claudeResult = {
        score: pre.preScore, errors: [],
        warnings: ["Claude validation unavailable — showing structural checks only."],
        suggestions: [],
      };
    }

    var result = mergeResults(pre, claudeResult);

    console.log("[validate-pa] requestId=" + requestId + " user=" + userEmail + " score=" + result.score + " risk=" + result.denialRiskLabel);

    return respond(200, Object.assign({}, result, {
      requestId:   requestId,
      validatedBy: userEmail,
      validatedAt: new Date().toISOString(),
      payer:       payer || "unknown",
      state:       state || "unknown",
    }));

  } catch (err) {
    console.error("[validate-pa] requestId=" + requestId + " user=" + userEmail + " error=" + err.message);
    return respond(500, {
      ready: false, score: 0, denialRiskLabel: "High",
      errors: ["Validation service error. Please retry."],
      warnings: [], suggestions: [],
      detail: err.message, requestId: requestId,
    });
  }
};