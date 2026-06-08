// netlify/functions/generate-pa.js
// AuraComply AI — PA Generation Engine v3.1
// UPDATED: Added silent P1 database save after generation
// CHANGE: Only added saveDraftToDatabase() function and one try/catch call
// EVERYTHING ELSE: 100% identical to v3.1 — zero generation logic changed

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

const REQUIRED_PATIENT_FIELDS = ["name", "dob", "diagnosis", "cptCode", "weeks"];
const DAILY_HOUR_CAP  = 8;
const DAILY_UNIT_CAP  = 32;

// ═══════════════════════════════════════════════════════════════════════════
// ✦ NEW — P1 DATABASE SAVE (silent — never blocks generation)
// ═══════════════════════════════════════════════════════════════════════════

const PAYER_ID_MAP = {
  aetna:    "a0000001-0000-0000-0000-000000000001",
  bcbs:     "a0000001-0000-0000-0000-000000000002",
  anthem:   "a0000001-0000-0000-0000-000000000002",
  uhc:      "a0000001-0000-0000-0000-000000000003",
  cigna:    "a0000001-0000-0000-0000-000000000004",
  molina:   "a0000001-0000-0000-0000-000000000005",
  medicaid: "a0000001-0000-0000-0000-000000000006",
};

const saveDraftToDatabase = async (structured, payer, state, requestId, userEmail) => {
  var supabaseUrl = process.env.SUPABASE_URL;
  var supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // If env vars not set yet — skip silently
  if (!supabaseUrl || !supabaseKey) {
    console.log("[P1-save] Supabase env vars not set — skipping save");
    return null;
  }

  var payerKey = (payer || "medicaid").toLowerCase();
  var payerId  = PAYER_ID_MAP[payerKey] || PAYER_ID_MAP["medicaid"];

  var payload = {
    session_id:          requestId,
    payer_id:            payerId,
    actor_role:          "system",
    draft_json:          structured,
    payer_rules_source:  "prompt_fallback",
  };

  try {
    var res = await fetch(
      supabaseUrl + "/functions/v1/validate-pa-draft",
      {
        method:  "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": "Bearer " + supabaseKey,
        },
        body: JSON.stringify(payload),
      }
    );

    var result = await res.json();
    console.log("[P1-save] Draft saved — draft_id=" + (result.draft_id || "unknown") +
      " risk=" + (result.overall_denial_risk || "?") +
      " status=" + (result.submission_status || "?"));
    return result.draft_id || null;

  } catch (saveErr) {
    // SILENT FAIL — user never knows, generation always succeeds
    console.error("[P1-save] Silent fail — " + saveErr.message);
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// PAYER RULES — unchanged from v3.1
// ═══════════════════════════════════════════════════════════════════════════

const PAYER_RULES = {
  medicaid: {
    label: "Medicaid / EPSDT",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap: 8, requiresMdOrder: false, requiresFBA: true, requiresVBMAPP: true,
    diagnosisWindow: null, renewalMonths: 6, portal: "State Medicaid portal",
    turnaroundDays: { standard: 3, urgent: 1 }, modifiers: ["HO", "HN", "95", "GT"],
    notes: `
    - EPSDT mandates coverage of medically necessary ABA for members under 21
    - CPTs requiring PA: 97153, 97154, 97155, 97156, 97157, 97158
    - 97153: max 40 units/week (10 hrs); 97155: max 8 units/day, BCBA must be present
    - 97156: max 8 units/week (2 hrs) family guidance
    - Required docs: VB-MAPP or ABLLS-R within 6 months, DSM-5 ASD diagnosis,
      FBA for behavior-reduction goals, 6-month treatment plan signed by BCBA
    - Modifiers: HO (BCBA), HN (bachelor level), 95 or GT (telehealth — state-specific)
    - Renewal: every 6 months with progress data and updated FBA`,
  },
  anthem: {
    label: "Anthem / BCBS Anthem",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap: 8, requiresMdOrder: false, requiresFBA: true, requiresVBMAPP: true,
    diagnosisWindow: 36, renewalMonths: 6, portal: "Availity",
    turnaroundDays: { standard: 5, urgent: 1 }, modifiers: ["HO", "95"],
    notes: `
    - CPTs requiring PA: 97153 (>10 hrs/week), 97155 always, 97156 bundled
    - 97155: max 8 hrs/week without peer review | 97156: max 2 hrs/week
    - Hard cap: 8 hrs/day combined
    - Required: ASD diagnosis within 3 years, BCBA credentials and state license
    - Portal: Availity | Turnaround: 3-5 business days standard, 1 day urgent`,
  },
  uhc: {
    label: "UnitedHealthcare / Optum",
    weeklyUnitCap: { "97153": 120, "97155": 32, "97156": 16, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap: 8, requiresMdOrder: true, requiresFBA: true, requiresVBMAPP: true,
    diagnosisWindow: null, renewalMonths: 6, portal: "uhcprovider.com",
    turnaroundDays: { standard: 3, urgent: 1 }, modifiers: ["HO", "95"],
    notes: `
    - CPTs requiring PA: all 97153-97158
    - 97153: peer review triggered above 30 hrs/week
    - 97155: requires active MD/DO order on file; max 8 hrs/week | 97156: max 4 hrs/week
    - Hard cap: 8 hrs/day combined
    - Portal: uhcprovider.com | Turnaround: 3 business days, 24 hrs urgent`,
  },
  bcbs: {
    label: "Blue Cross Blue Shield",
    weeklyUnitCap: { "97153": 160, "97155": 32, "97156": 16, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap: 8, requiresMdOrder: false, requiresFBA: true, requiresVBMAPP: true,
    diagnosisWindow: 36, renewalMonths: 6, portal: "Varies by state affiliate",
    turnaroundDays: { standard: 5, urgent: 2 }, modifiers: ["HO", "95"],
    notes: `
    - BCBS varies by state affiliate — confirm rules with specific plan
    - CPTs requiring PA: all 97153-97158 | Hard cap: 8 hrs/day MUE limit`,
  },
  aetna: {
    label: "Aetna / CVS Health",
    weeklyUnitCap: { "97153": 32, "97155": 32, "97156": 8, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap: 8, requiresMdOrder: true, requiresFBA: true, requiresVBMAPP: true,
    diagnosisWindow: 24, renewalMonths: 6, portal: "Availity or NaviMedix",
    turnaroundDays: { standard: 3, urgent: 1 }, modifiers: ["HO", "95"],
    notes: `
    - CPTs requiring PA: all 97153-97158
    - 97153: up to 32 units/week (8 hrs) — above triggers peer review
    - 97156: max 2 hrs/week | Diagnosis must be within 2 years
    - Portal: Availity or NaviMedix | Turnaround: 3 days standard, 1 day urgent`,
  },
  cigna: {
    label: "Cigna / Evernorth",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap: 8, requiresMdOrder: false, requiresFBA: true, requiresVBMAPP: true,
    diagnosisWindow: 36, renewalMonths: 6, portal: "Cigna for Health Care Professionals portal",
    turnaroundDays: { standard: 5, urgent: 2 }, modifiers: ["HO", "95"],
    notes: `
    - CPTs requiring PA: 97153, 97155 always; 97156 bundled most plans
    - Hard cap: 8 hrs/day combined | Modifiers: HO, 95 standard`,
  },
  molina: {
    label: "Molina Healthcare",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap: 8, requiresMdOrder: false, requiresFBA: true, requiresVBMAPP: true,
    diagnosisWindow: null, renewalMonths: 6, portal: "Molina state portal",
    turnaroundDays: { standard: 5, urgent: 2 }, modifiers: ["HO", "95", "GT"],
    notes: `
    - Medicaid MCO — EPSDT applies for members under 21
    - CPTs requiring PA: all 97153-97158 | Hard cap: 8 hrs/day combined
    - Modifiers: HO, 95 or GT depending on state`,
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// CPT & ICD10 REFERENCE — unchanged
// ═══════════════════════════════════════════════════════════════════════════

const CPT_REFERENCE = {
  "97153": { name: "Adaptive Behavior Treatment (Individual DTT)",    unit: "15 min", provider: "BT/RBT under BCBA" },
  "97154": { name: "Group Adaptive Behavior Treatment",               unit: "15 min", provider: "BT/RBT under BCBA" },
  "97155": { name: "Adaptive Behavior Treatment with Protocol Mod",   unit: "15 min", provider: "BCBA (HO required)" },
  "97156": { name: "Family Adaptive Behavior Treatment Guidance",     unit: "15 min", provider: "BCBA (HO required)" },
  "97157": { name: "Multiple-Family Group Behavior Treatment",        unit: "15 min", provider: "BCBA (HO required)" },
  "97158": { name: "Group Adaptive Behavior Treatment with Protocol", unit: "15 min", provider: "BCBA (HO required)" },
};

const ICD10_REFERENCE = {
  "F84.0": "Autistic Disorder (Classic Autism) — DSM-5",
  "F84.5": "Asperger Syndrome — DSM-5",
  "F84.8": "Other Pervasive Developmental Disorders",
  "F84.9": "Pervasive Developmental Disorder, Unspecified",
};

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS — unchanged
// ═══════════════════════════════════════════════════════════════════════════

const buildSystemPrompt = (payer, state, payerType) => {
  const payerKey  = (payer || "medicaid").toLowerCase();
  const rules     = PAYER_RULES[payerKey];
  const rulesText = rules
    ? `PAYER: ${rules.label} | PORTAL: ${rules.portal}
DAILY HOUR CAP: ${rules.dailyHourCap} hrs | RENEWAL: every ${rules.renewalMonths} months
REQUIRES MD ORDER: ${rules.requiresMdOrder} | REQUIRES FBA: ${rules.requiresFBA}
DIAGNOSIS WINDOW: ${rules.diagnosisWindow ? rules.diagnosisWindow + " months" : "No expiry (EPSDT)"}
MODIFIERS: ${rules.modifiers.join(", ")}
TURNAROUND: ${rules.turnaroundDays.standard} days standard / ${rules.turnaroundDays.urgent} day urgent
RULES:${rules.notes}`
    : `Payer: ${payer} | State: ${state} | Type: ${payerType}. Confirm rules with payer policy before submission.`;

  return `You are an expert ABA prior authorization specialist for AuraComply AI.
Your drafts must meet clinical and payer standards to survive peer review.
STATE: ${state} | PAYER: ${payer} | TYPE: ${payerType}

${rulesText}

CPT CODE REFERENCE:
${Object.entries(CPT_REFERENCE).map(([cpt, v]) => `${cpt}: ${v.name} | ${v.unit} | ${v.provider}`).join("\n")}

ICD-10 REFERENCE:
${Object.entries(ICD10_REFERENCE).map(([code, label]) => `${code}: ${label}`).join("\n")}

HARD RULES — NEVER VIOLATE:
1. Daily cap: ${DAILY_HOUR_CAP} hrs/day combined (${DAILY_UNIT_CAP} units) across 97153+97154+97155+97158
2. Units = 15-min increments (1 hr = 4 units)
3. Never invent facts — mark unknowns as "[CONFIRM WITH PROVIDER]"
4. Never suggest diagnosis — only use the provided ICD-10
5. 97155 always requires HO modifier; always requires BCBA as rendering provider
6. SMART goals must be measurable with baseline data, target, and timeline
7. Section 9 LMN bullets must use the Proof Triplet format:
   Assessment finding → Functional Loss → Least Restrictive Environment justification
8. End EVERY response with the compliance footer

OUTPUT FORMAT — return ONLY valid JSON, no markdown, no preamble, no explanation.
The JSON must match this exact schema (all keys required, no extras):
{
  "section1":  { "header": "", "bullets": ["","","","",""] },
  "section2":  { "memberId": "", "dob": "", "age": "", "gender": "", "address": "",
                 "payerType": "", "payerName": "", "planId": "" },
  "section3":  { "cpt": "", "description": "", "unitsPerWeek": 0, "unitsPerMonth": 0,
                 "unitType": "15 min", "hrsPerDay": 0, "hrsPerWeek": 0,
                 "effectiveDates": "", "authType": "" },
  "section4":  { "bcbaName": "", "bcbaLicense": "", "bcbaNpi": "", "physician": "",
                 "physicianNpi": "", "clinic": "", "clinicNpi": "", "enrollmentStatus": "" },
  "section5":  { "icd10": "", "diagnosisDate": "", "diagnosticTool": "",
                 "assessmentMethod": "", "assessmentDate": "",
                 "keyFindings": ["","",""],
                 "impairments": { "communication": "", "social": "", "adl": "",
                                  "safety": "", "behavior": "" },
                 "goals": ["","","","","","",""] },
  "section6":  { "placeOfService": "", "telehealth": "", "telehealthModifier": "",
                 "payerTelehealthNote": "" },
  "section7":  { "units97156": 0, "units97157": 0, "whoAttends": "",
                 "frequency": "", "barriers": "" },
  "section8":  { "requestType": "", "priorAuthNumber": "", "priorDates": "",
                 "notes": "", "mueCompliance": "" },
  "section9":  { "bullets": ["","","","","","",""],
                 "physicianSignature": "", "bcbaSignature": "" },
  "section10": { "checklist": ["","","","",""] },
  "section11": { "bullets": ["","","","",""] }
}
After the JSON, on a new line write exactly:
--- AURACOMPLY DRAFT — Clinician review required before submission. ---`;
};

const buildUserPrompt = (body, userEmail) => {
  const { patientData: p, payer, state, payerType, payerName, authType, clinicianNotes, isMedicaidArmed } = body;

  const hrsPerWeek    = parseFloat(p.hoursPerWeek) || 0;
  const unitsPerWeek  = Math.round(hrsPerWeek * 4);
  const weeks         = parseInt(p.weeks) || 12;
  const unitsPerMonth = Math.round((unitsPerWeek / 7) * 30.44);
  const mueFlag       = (hrsPerWeek / 5) > DAILY_HOUR_CAP
    ? `⚠ REQUESTED HOURS EXCEED ${DAILY_HOUR_CAP} HR/DAY CAP — address in Section 8 mueCompliance`
    : "MUE compliant";

  return `Generate a complete 11-section ABA PA draft. Submitted by: ${userEmail}

REQUEST PARAMETERS:
state=${state}
payer=${payer}
payer_type=${payerType || "Medicaid"}
payer_name=${payerName || payer}
auth_type=${authType || "initial"}
medicaid_armed=${isMedicaidArmed || "yes"}
mue_status=${mueFlag}

PATIENT:
  insurance_id=${p.insuranceId || "[CONFIRM WITH PROVIDER]"}
  name=${p.name}
  dob=${p.dob}
  gender=${p.gender || "[CONFIRM WITH PROVIDER]"}
  address=${p.address || "[CONFIRM WITH PROVIDER]"}

DIAGNOSIS:
  icd10=${p.diagnosis}
  label=${ICD10_REFERENCE[p.diagnosis] || "Confirm with provider"}
  date=${p.diagnosisDate || "[CONFIRM WITH PROVIDER]"}
  tool=${p.diagnosticTool || "[CONFIRM WITH PROVIDER]"}

ASSESSMENT:
  type=${p.assessmentType || "VB-MAPP"}
  vbmapp_score=${p.vbmapp || "[CONFIRM WITH PROVIDER]"}
  abllsr_score=${p.abllsr || "[CONFIRM WITH PROVIDER]"}
  vineland_score=${p.vineland || "[CONFIRM WITH PROVIDER]"}
  date=${p.assessDate || "[CONFIRM WITH PROVIDER]"}

PROVIDER:
  bcba_name=${p.bcbaName || "[CONFIRM WITH PROVIDER]"}
  bcba_license=${p.bcbaLicense || "[CONFIRM WITH PROVIDER]"}
  bcba_npi=${p.bcbaNpi || "[CONFIRM WITH PROVIDER]"}
  supervising_physician=${p.supervisingMd || "[CONFIRM WITH PROVIDER]"}
  clinic=${p.clinicName || "[CONFIRM WITH PROVIDER]"}
  clinic_npi=${p.clinicNpi || "[CONFIRM WITH PROVIDER]"}

SERVICE:
  cpt=${p.cptCode}
  cpt_description=${CPT_REFERENCE[p.cptCode] ? CPT_REFERENCE[p.cptCode].name : "See CPT reference"}
  hrs_per_week=${hrsPerWeek}
  units_per_week=${unitsPerWeek}
  units_per_month=${unitsPerMonth}
  weeks=${weeks}
  start_date=${p.startDate || "[CONFIRM WITH PROVIDER]"}
  setting=${p.setting || "Home"}
  telehealth=${p.telehealth || "No"}
  prior_auth_number=${p.priorAuthNumber || "N/A"}

CLINICIAN NOTES:
${clinicianNotes || "See clinical documentation on file."}

Return ONLY the JSON object. No markdown. No explanation.`;
};

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE API CALL — unchanged
// ═══════════════════════════════════════════════════════════════════════════

const callClaude = async (messages, systemPrompt, retries) => {
  if (retries === undefined) retries = 2;
  for (var attempt = 0; attempt <= retries; attempt++) {
    var res = await fetch(CLAUDE, {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         process.env.ANTHROPIC_API_KEY,
        "anthropic-version": VERSION,
      },
      body: JSON.stringify({
        model:          MODEL,
        max_tokens:     4096,
        system:         systemPrompt,
        messages:       messages,
        stop_sequences: ["--- AURACOMPLY"],
      }),
    });

    if (res.ok) {
      var data = await res.json();
      return { text: (data && data.content && data.content[0] ? data.content[0].text : "").trim(), usage: data.usage };
    }

    if ((res.status === 529 || res.status === 503) && attempt < retries) {
      await new Promise(function(r) { setTimeout(r, 1500 * (attempt + 1)); });
      continue;
    }

    var errText = await res.text();
    throw new Error("Claude API " + res.status + ": " + errText.slice(0, 400));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// JSON PARSER — unchanged
// ═══════════════════════════════════════════════════════════════════════════

const safeParseJSON = (text) => {
  try {
    var cleaned = text
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/,      "")
      .replace(/```\s*$/,      "")
      .trim();
    var start = cleaned.indexOf("{");
    var end   = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object found");
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch (e) {
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DRAFT FORMATTER — unchanged
// ═══════════════════════════════════════════════════════════════════════════

const formatDraft = (s, payer, state) => {
  var bullet   = function(arr) { return (arr || []).map(function(b) { return "  • " + b; }).join("\n"); };
  var numbered = function(arr) { return (arr || []).map(function(g, i) { return "  " + (i+1) + ". " + g; }).join("\n"); };
  var check    = function(arr) { return (arr || []).map(function(c) { return "  ☐ " + c; }).join("\n"); };

  return "PRIOR AUTHORIZATION DRAFT — AuraComply AI\n" +
    "Payer: " + payer + " | State: " + state + "\n" +
    "Generated: " + new Date().toUTCString() + "\n" +
    "══════════════════════════════════════════════════════════\n\n" +
    "SECTION 1 — PRIOR AUTHORIZATION HEADER\n" +
    (s.section1 && s.section1.header ? s.section1.header : "") + "\n" +
    bullet(s.section1 && s.section1.bullets) + "\n\n" +
    "SECTION 2 — PATIENT METADATA\n" +
    "  Medicaid ID / Member ID : " + (s.section2 && s.section2.memberId  || "") + "\n" +
    "  Date of Birth            : " + (s.section2 && s.section2.dob       || "") + "\n" +
    "  Age                      : " + (s.section2 && s.section2.age       || "") + "\n" +
    "  Gender                   : " + (s.section2 && s.section2.gender    || "") + "\n" +
    "  Payer Type               : " + (s.section2 && s.section2.payerType || "") + "\n" +
    "  Payer Name               : " + (s.section2 && s.section2.payerName || "") + "\n\n" +
    "SECTION 3 — SERVICE DATA BY CPT\n" +
    "  CPT Code          : " + (s.section3 && s.section3.cpt          || "") + "\n" +
    "  Description       : " + (s.section3 && s.section3.description  || "") + "\n" +
    "  Units / Week      : " + (s.section3 && s.section3.unitsPerWeek || "") + "\n" +
    "  Hours / Week      : " + (s.section3 && s.section3.hrsPerWeek   || "") + "\n" +
    "  Effective Dates   : " + (s.section3 && s.section3.effectiveDates || "") + "\n\n" +
    "SECTION 4 — PROVIDER AND CREDENTIALING\n" +
    "  Rendering BCBA        : " + (s.section4 && s.section4.bcbaName    || "") + "\n" +
    "  BCBA License          : " + (s.section4 && s.section4.bcbaLicense || "") + "\n" +
    "  BCBA NPI              : " + (s.section4 && s.section4.bcbaNpi     || "") + "\n" +
    "  Supervising Physician : " + (s.section4 && s.section4.physician   || "") + "\n" +
    "  Clinic / Agency       : " + (s.section4 && s.section4.clinic      || "") + "\n\n" +
    "SECTION 5 — CLINICAL DOCUMENTATION\n" +
    "  ICD-10 Diagnosis  : " + (s.section5 && s.section5.icd10            || "") + "\n" +
    "  Assessment Method : " + (s.section5 && s.section5.assessmentMethod || "") + "\n\n" +
    "  Key Findings:\n" + bullet(s.section5 && s.section5.keyFindings) + "\n\n" +
    "  Treatment Plan Goals (SMART):\n" + numbered(s.section5 && s.section5.goals) + "\n\n" +
    "SECTION 6 — SETTING AND MODALITY\n" +
    "  Place of Service : " + (s.section6 && s.section6.placeOfService || "") + "\n" +
    "  Telehealth       : " + (s.section6 && s.section6.telehealth     || "") + "\n\n" +
    "SECTION 7 — PARENT AND CAREGIVER INVOLVEMENT\n" +
    "  97156 Units/Month : " + (s.section7 && s.section7.units97156 || "") + "\n" +
    "  Who Attends       : " + (s.section7 && s.section7.whoAttends  || "") + "\n\n" +
    "SECTION 8 — AUTHORIZATION FLAGS\n" +
    "  MUE Compliance : " + (s.section8 && s.section8.mueCompliance || "") + "\n\n" +
    "SECTION 9 — MEDICAL NECESSITY SUMMARY (LMN)\n" +
    bullet(s.section9 && s.section9.bullets) + "\n\n" +
    "  Physician Sig : " + (s.section9 && s.section9.physicianSignature || "[Required]") + "\n" +
    "  BCBA Sig      : " + (s.section9 && s.section9.bcbaSignature      || "[Required]") + "\n\n" +
    "SECTION 10 — PRE-SUBMISSION CHECKLIST\n" +
    check(s.section10 && s.section10.checklist) + "\n\n" +
    "SECTION 11 — AURACOMPLY AI ALIGNMENT\n" +
    bullet(s.section11 && s.section11.bullets) + "\n\n" +
    "══════════════════════════════════════════════════════════\n" +
    "--- AURACOMPLY DRAFT — Clinician review required before submission. ---";
};

// ═══════════════════════════════════════════════════════════════════════════
// HELPER — unchanged
// ═══════════════════════════════════════════════════════════════════════════

const respond = (statusCode, data) => ({
  statusCode: statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(data),
});

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — one try/catch added after successful generation
// ═══════════════════════════════════════════════════════════════════════════

exports.handler = async function(event, context) {

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return respond(500, {
      error: "Server configuration error: ANTHROPIC_API_KEY is not set in Netlify environment variables.",
      status: "config_error",
    });
  }

  var DEV_MODE    = process.env.DEV_MODE === "true";
  var netlifyUser = context && context.clientContext && context.clientContext.user
    ? context.clientContext.user : null;

  if (!DEV_MODE && !netlifyUser) {
    return respond(401, { error: "Unauthorized. Please sign in.", status: "auth_error" });
  }

  var userEmail = netlifyUser ? (netlifyUser.email || "unknown") : "dev-test@auracomply.ai";
  var requestId = "pa-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);

  try {

    var body;
    try {
      body = JSON.parse(event.body);
    } catch (e) {
      return respond(400, { error: "Invalid JSON body", status: "validation_error", requestId: requestId });
    }

    var patientData = body.patientData;
    var payer       = body.payer;
    var state       = body.state;
    var payerType   = body.payerType;

    var missing = REQUIRED_PATIENT_FIELDS.filter(function(f) { return !patientData || !patientData[f]; });
    if (missing.length > 0) {
      return respond(400, { error: "Missing required fields: " + missing.join(", "), status: "validation_error", requestId: requestId });
    }

    if (!payer || !state) {
      return respond(400, { error: "payer and state are required.", status: "validation_error", requestId: requestId });
    }

    var sanitize = function(v) { return typeof v === "string" ? v.replace(/<[^>]*>/g, "").slice(0, 500) : v; };
    var safeP    = {};
    Object.keys(patientData).forEach(function(k) { safeP[k] = sanitize(patientData[k]); });

    var hrsPerWeek  = parseFloat(safeP.hoursPerWeek) || 0;
    var hrsPerDay   = hrsPerWeek / 5;
    var mueBreached = hrsPerDay > DAILY_HOUR_CAP;

    var systemPrompt = buildSystemPrompt(payer, state, payerType || "Medicaid");
    var userPrompt   = buildUserPrompt(Object.assign({}, body, { patientData: safeP }), userEmail);

    var messages = [
      { role: "user",      content: userPrompt },
      { role: "assistant", content: "{" },
    ];

    var claudeResult = await callClaude(messages, systemPrompt);
    var fullText     = "{" + claudeResult.text;
    var usage        = claudeResult.usage;

    var structured = safeParseJSON(fullText);

    if (!structured) {
      return respond(200, {
        draft: fullText, structured: null, status: "success_raw",
        warning: "JSON parse failed — raw text returned. Review manually.",
        payer: payer, state: state, payerType: payerType,
        requestId: requestId, generatedBy: userEmail,
        generatedAt: new Date().toISOString(),
        meta: { model: MODEL, inputTokens: usage && usage.input_tokens, outputTokens: usage && usage.output_tokens },
      });
    }

    // ✦ NEW — Save to P1 database (fire-and-forget — never blocks generation)
    saveDraftToDatabase(structured, payer, state, requestId, userEmail).catch(function(e) {
      console.error("[P1-save] Silent fail — " + e.message);
    });
    // ✦ END NEW

    var draft = formatDraft(structured, payer, state);

    var payerKey  = (payer || "").toLowerCase();
    var payerRule = PAYER_RULES[payerKey];
    var payerMeta = payerRule ? {
      label: payerRule.label, portal: payerRule.portal,
      turnaround: payerRule.turnaroundDays, renewalMonths: payerRule.renewalMonths,
      requiresMdOrder: payerRule.requiresMdOrder,
    } : null;

    return respond(200, {
      draft: draft, structured: structured, status: "success",
      payer: payer, state: state, payerType: payerType,
      mueWarning: mueBreached
        ? "Requested " + hrsPerWeek + " hrs/week = " + hrsPerDay.toFixed(1) + " hrs/day — exceeds " + DAILY_HOUR_CAP + " hr/day cap. Review Section 8."
        : null,
      payerMeta: payerMeta,
      requestId: requestId, generatedBy: userEmail,
      generatedAt: new Date().toISOString(),
      meta: { model: MODEL, inputTokens: usage && usage.input_tokens, outputTokens: usage && usage.output_tokens },
    });

  } catch (err) {
    console.error("[generate-pa] requestId=" + requestId + " user=" + userEmail + " error=" + err.message);
    var isKeyError = err.message && (
      err.message.includes("401") ||
      err.message.includes("authentication") ||
      err.message.includes("api_key") ||
      err.message.includes("invalid x-api-key")
    );
    return respond(500, {
      error: isKeyError
        ? "Anthropic API key is invalid. Check ANTHROPIC_API_KEY in Netlify environment variables."
        : "Server error generating PA draft: " + err.message,
      detail: err.message,
      status: "server_error",
      requestId: requestId,
    });
  }
};
