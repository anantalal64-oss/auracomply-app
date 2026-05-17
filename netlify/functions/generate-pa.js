// netlify/functions/generate-pa.js
// AuraComply AI — PA Generation Engine v3.0
// Model: claude-sonnet-4-6 (upgraded from haiku — PA drafts need reasoning depth)
// Auth:  Netlify Identity JWT → context.clientContext.user
// Sync:  session keys aura_auth / aura_user / aura_name set by login.html
//
// HOW AUTH FLOWS FROM login.html → app.html → THIS FUNCTION:
//   1. login.html writes sessionStorage.aura_auth = "true", aura_user = email
//   2. app.html reads sessionStorage, calls netlifyIdentity.currentUser()
//      to get the JWT access_token
//   3. app.html passes token in Authorization: Bearer <token> header
//   4. Netlify validates JWT and populates context.clientContext.user here
//   5. This function rejects any request missing a valid identity
//
// FRONTEND CALL PATTERN (paste into app.html fetch):
//   const token = netlifyIdentity.currentUser()?.token?.access_token;
//   fetch('/api/generate-pa', {
//     method: 'POST',
//     headers: {
//       'Content-Type': 'application/json',
//       'Authorization': `Bearer ${token}`   ← required
//     },
//     body: JSON.stringify({ patientData, payer, state, payerType, ... })
//   });

"use strict";

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const MODEL   = "claude-sonnet-4-6";   // upgraded: PA drafts need reasoning depth
const CLAUDE  = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

// Fields that must exist before we hit Claude
const REQUIRED_PATIENT_FIELDS = ["name", "dob", "diagnosis", "cptCode", "weeks"];

// MUE (Medically Unlikely Edit) hard caps — CMS / payer universal
const DAILY_HOUR_CAP  = 8;    // 8 hrs/day combined ABA codes
const DAILY_UNIT_CAP  = 32;   // 8 hrs × 4 units/hr

// ═══════════════════════════════════════════════════════════════════════════
// PAYER RULES — Single Source of Truth
// Keeps validate-pa.js and generate-pa.js in perfect alignment.
// Any payer rule change goes here ONLY.
// ═══════════════════════════════════════════════════════════════════════════

const PAYER_RULES = {

  medicaid: {
    label: "Medicaid / EPSDT",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8,  "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap:  8,
    requiresMdOrder:    false,
    requiresFBA:        true,
    requiresVBMAPP:     true,
    diagnosisWindow:    null,
    renewalMonths:      6,
    portal:             "State Medicaid portal",
    turnaroundDays:     { standard: 3, urgent: 1 },
    modifiers:          ["HO", "HN", "95", "GT"],
    notes: `
    - EPSDT mandates coverage of medically necessary ABA for members under 21
    - CPTs requiring PA: 97153, 97154, 97155, 97156, 97157, 97158
    - 97153: max 40 units/week (10 hrs); 97155: max 8 units/day, BCBA must be present
    - 97156: max 8 units/week (2 hrs) family guidance
    - Required docs: VB-MAPP or ABLLS-R within 6 months, DSM-5 ASD diagnosis,
      FBA for behavior-reduction goals, 6-month treatment plan signed by BCBA
    - Modifiers: HO (BCBA), HN (bachelor level), 95 or GT (telehealth — state-specific)
    - Medicaid member ID required on every PA form
    - Renewal: every 6 months with progress data and updated FBA`,
  },

  anthem: {
    label: "Anthem / BCBS Anthem",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8,  "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap:  8,
    requiresMdOrder:    false,
    requiresFBA:        true,
    requiresVBMAPP:     true,
    diagnosisWindow:    36,
    renewalMonths:      6,
    portal:             "Availity",
    turnaroundDays:     { standard: 5, urgent: 1 },
    modifiers:          ["HO", "95"],
    notes: `
    - CPTs requiring PA: 97153 (>10 hrs/week), 97155 always, 97156 bundled
    - 97155: max 8 hrs/week without peer review; above triggers clinical review
    - 97156: max 2 hrs/week
    - Hard cap: 8 hrs/day combined
    - Required: ASD diagnosis within 3 years, EIBI documentation for children under 7,
      BCBA credentials and state license number
    - Renewal: progress notes covering last 6 months required
    - Modifiers: HO (BCBA supervision), 95 (telehealth)
    - Portal: Availity | Turnaround: 3–5 business days standard, 1 day urgent`,
  },

  uhc: {
    label: "UnitedHealthcare / Optum",
    weeklyUnitCap: { "97153": 120, "97155": 32, "97156": 16, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap:  8,
    requiresMdOrder:    true,
    requiresFBA:        true,
    requiresVBMAPP:     true,
    diagnosisWindow:    null,
    renewalMonths:      6,
    portal:             "uhcprovider.com",
    turnaroundDays:     { standard: 3, urgent: 1 },
    modifiers:          ["HO", "95"],
    notes: `
    - CPTs requiring PA: all 97153–97158
    - 97153: peer review triggered above 30 hrs/week
    - 97155: requires active MD or DO order on file; max 8 hrs/week
    - 97156: max 4 hrs/week
    - Hard cap: 8 hrs/day combined
    - Required: UHC-credentialed provider, FBA for all new auths,
      active BACB certification, MD order for 97155
    - Modifiers: HO (BCBA level), 95 (telehealth)
    - Portal: uhcprovider.com | Turnaround: 3 business days, 24 hrs urgent`,
  },

  bcbs: {
    label: "Blue Cross Blue Shield",
    weeklyUnitCap: { "97153": 160, "97155": 32, "97156": 16, "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap:  8,
    requiresMdOrder:    false,
    requiresFBA:        true,
    requiresVBMAPP:     true,
    diagnosisWindow:    36,
    renewalMonths:      6,
    portal:             "Varies by state affiliate",
    turnaroundDays:     { standard: 5, urgent: 2 },
    modifiers:          ["HO", "95"],
    notes: `
    - NOTE: BCBS varies by state affiliate — confirm rules with specific plan
    - CPTs requiring PA: all 97153–97158
    - Behavioral health auth is separate from medical auth
    - 97153: up to 40 hrs/week with strong clinical justification
    - 97156: typically 2–4 hrs/week
    - Hard cap: 8 hrs/day MUE limit
    - Required: BCBA license verification, ASD diagnosis within 2–3 years,
      individualized treatment plan with SMART goals, FBA for behavior reduction
    - Modifiers: HO (BCBA supervision), 95 (telehealth)`,
  },

  aetna: {
    label: "Aetna / CVS Health",
    weeklyUnitCap: { "97153": 32, "97155": 32, "97156": 8,  "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap:  8,
    requiresMdOrder:    true,
    requiresFBA:        true,
    requiresVBMAPP:     true,
    diagnosisWindow:    24,
    renewalMonths:      6,
    portal:             "Availity or NaviMedix",
    turnaroundDays:     { standard: 3, urgent: 1 },
    modifiers:          ["HO", "95"],
    notes: `
    - CPTs requiring PA: all 97153–97158
    - Aetna uses their own Behavioral Health PA form
    - 97153: up to 32 units/week (8 hrs) — above triggers peer review
    - 97155: max 8 hrs/week without peer review
    - 97156: max 2 hrs/week standard
    - Hard cap: 8 hrs/day combined
    - Required: DSM-5 ASD diagnosis CONFIRMED (not suspected), evaluation report,
      FBA for behavior-reduction goals, BCBA credentials, physician referral
    - Diagnosis must be within 2 years
    - Common denials: missing FBA, diagnosis not confirmed, hours exceed threshold
    - Modifiers: HO (BCBA services), 95 (telehealth)
    - Portal: Availity or NaviMedix | Turnaround: 3 days standard, 1 day urgent`,
  },

  cigna: {
    label: "Cigna / Evernorth",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8,  "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap:  8,
    requiresMdOrder:    false,
    requiresFBA:        true,
    requiresVBMAPP:     true,
    diagnosisWindow:    36,
    renewalMonths:      6,
    portal:             "Cigna for Health Care Professionals portal",
    turnaroundDays:     { standard: 5, urgent: 2 },
    modifiers:          ["HO", "95"],
    notes: `
    - CPTs requiring PA: 97153, 97155 always; 97156 bundled most plans
    - Hard cap: 8 hrs/day combined
    - Modifiers: HO, 95 standard
    - Required: BCBA credentials, ASD diagnosis, treatment plan
    - State-specific rules apply — confirm exact caps with payer policy`,
  },

  molina: {
    label: "Molina Healthcare",
    weeklyUnitCap: { "97153": 40, "97155": 32, "97156": 8,  "97154": 16, "97157": 8, "97158": 16 },
    dailyHourCap:  8,
    requiresMdOrder:    false,
    requiresFBA:        true,
    requiresVBMAPP:     true,
    diagnosisWindow:    null,
    renewalMonths:      6,
    portal:             "Molina state portal",
    turnaroundDays:     { standard: 5, urgent: 2 },
    modifiers:          ["HO", "95", "GT"],
    notes: `
    - Medicaid MCO — EPSDT applies for members under 21
    - CPTs requiring PA: all 97153–97158
    - Hard cap: 8 hrs/day combined
    - Required: VB-MAPP or ABLLS-R, DSM-5 diagnosis, treatment plan, BCBA credentials
    - Modifiers: HO, 95 or GT depending on state
    - State-specific rules — confirm with your state Molina plan`,
  },

};

// ═══════════════════════════════════════════════════════════════════════════
// CPT CODE REFERENCE
// ═══════════════════════════════════════════════════════════════════════════

const CPT_REFERENCE = {
  "97153": { name: "Adaptive Behavior Treatment (Individual DTT)",   unit: "15 min", provider: "BT/RBT under BCBA" },
  "97154": { name: "Group Adaptive Behavior Treatment",              unit: "15 min", provider: "BT/RBT under BCBA" },
  "97155": { name: "Adaptive Behavior Treatment with Protocol Mod",  unit: "15 min", provider: "BCBA (HO required)" },
  "97156": { name: "Family Adaptive Behavior Treatment Guidance",    unit: "15 min", provider: "BCBA (HO required)" },
  "97157": { name: "Multiple-Family Group Behavior Treatment",       unit: "15 min", provider: "BCBA (HO required)" },
  "97158": { name: "Group Adaptive Behavior Treatment with Protocol",unit: "15 min", provider: "BCBA (HO required)" },
};

const ICD10_REFERENCE = {
  "F84.0": "Autistic Disorder (Classic Autism) — DSM-5",
  "F84.5": "Asperger Syndrome — DSM-5",
  "F84.8": "Other Pervasive Developmental Disorders",
  "F84.9": "Pervasive Developmental Disorder, Unspecified",
};

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDERS
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
  const {
    patientData: p, payer, state, payerType, payerName,
    authType, clinicianNotes, isMedicaidArmed
  } = body;

  const hrsPerWeek   = parseFloat(p.hoursPerWeek) || 0;
  const unitsPerWeek = Math.round(hrsPerWeek * 4);
  const weeks        = parseInt(p.weeks) || 12;
  const unitsPerMonth = Math.round((unitsPerWeek / 7) * 30.44);

  const mueFlag = (hrsPerWeek / 5) > DAILY_HOUR_CAP
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
  cpt_description=${CPT_REFERENCE[p.cptCode]?.name || "See CPT reference"}
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
// CLAUDE API CALL — with retry on 529 (overload) and 503
// ═══════════════════════════════════════════════════════════════════════════

const callClaude = async (messages, systemPrompt, retries = 2) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(CLAUDE, {
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
        messages,
        stop_sequences: ["--- AURACOMPLY"],
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return { text: (data?.content?.[0]?.text || "").trim(), usage: data.usage };
    }

    if ((res.status === 529 || res.status === 503) && attempt < retries) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }

    const errText = await res.text();
    throw new Error(`Claude API ${res.status}: ${errText.slice(0, 400)}`);
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// JSON PARSER
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
    if (start === -1 || end === -1) throw new Error("No JSON object found");
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// DRAFT FORMATTER
// ═══════════════════════════════════════════════════════════════════════════

const formatDraft = (s, payer, state) => {
  const bullet  = (arr) => (arr || []).map(b => `  • ${b}`).join("\n");
  const numbered = (arr) => (arr || []).map((g, i) => `  ${i + 1}. ${g}`).join("\n");
  const check   = (arr) => (arr || []).map(c => `  ☐ ${c}`).join("\n");

  return `PRIOR AUTHORIZATION DRAFT — AuraComply AI
Payer: ${payer} | State: ${state}
Generated: ${new Date().toUTCString()}
══════════════════════════════════════════════════════════

SECTION 1 — PRIOR AUTHORIZATION HEADER
${s.section1?.header || ""}
${bullet(s.section1?.bullets)}

SECTION 2 — PATIENT METADATA
  Medicaid ID / Member ID : ${s.section2?.memberId || ""}
  Date of Birth            : ${s.section2?.dob || ""}
  Age                      : ${s.section2?.age || ""}
  Gender                   : ${s.section2?.gender || ""}
  Address                  : ${s.section2?.address || ""}
  Payer Type               : ${s.section2?.payerType || ""}
  Payer Name               : ${s.section2?.payerName || ""}
  Plan ID                  : ${s.section2?.planId || ""}

SECTION 3 — SERVICE DATA BY CPT
  CPT Code          : ${s.section3?.cpt || ""}
  Description       : ${s.section3?.description || ""}
  Units / Week      : ${s.section3?.unitsPerWeek || ""}
  Units / Month     : ${s.section3?.unitsPerMonth || ""}
  Unit Type         : ${s.section3?.unitType || "15 min"}
  Hours / Day       : ${s.section3?.hrsPerDay || ""}
  Hours / Week      : ${s.section3?.hrsPerWeek || ""}
  Effective Dates   : ${s.section3?.effectiveDates || ""}
  Authorization Type: ${s.section3?.authType || ""}

SECTION 4 — PROVIDER AND CREDENTIALING
  Rendering BCBA        : ${s.section4?.bcbaName || ""}
  BCBA License          : ${s.section4?.bcbaLicense || ""}
  BCBA NPI              : ${s.section4?.bcbaNpi || ""}
  Supervising Physician : ${s.section4?.physician || ""}
  Physician NPI         : ${s.section4?.physicianNpi || ""}
  Clinic / Agency       : ${s.section4?.clinic || ""}
  Clinic NPI            : ${s.section4?.clinicNpi || ""}
  Enrollment Status     : ${s.section4?.enrollmentStatus || ""}

SECTION 5 — CLINICAL DOCUMENTATION
  ICD-10 Diagnosis  : ${s.section5?.icd10 || ""}
  Diagnosis Date    : ${s.section5?.diagnosisDate || ""}
  Diagnostic Tool   : ${s.section5?.diagnosticTool || ""}
  Assessment Method : ${s.section5?.assessmentMethod || ""}
  Assessment Date   : ${s.section5?.assessmentDate || ""}

  Key Findings:
${bullet(s.section5?.keyFindings)}

  Functional Impairments:
    Communication       : ${s.section5?.impairments?.communication || ""}
    Social Interaction  : ${s.section5?.impairments?.social || ""}
    Activities of Daily : ${s.section5?.impairments?.adl || ""}
    Safety              : ${s.section5?.impairments?.safety || ""}
    Behavior            : ${s.section5?.impairments?.behavior || ""}

  Treatment Plan Goals (SMART):
${numbered(s.section5?.goals)}

SECTION 6 — SETTING AND MODALITY
  Place of Service      : ${s.section6?.placeOfService || ""}
  Telehealth            : ${s.section6?.telehealth || ""}
  Telehealth Modifier   : ${s.section6?.telehealthModifier || ""}
  Payer Telehealth Note : ${s.section6?.payerTelehealthNote || ""}

SECTION 7 — PARENT AND CAREGIVER INVOLVEMENT
  97156 Units / Month : ${s.section7?.units97156 || ""}
  97157 Units / Month : ${s.section7?.units97157 || ""}
  Who Attends         : ${s.section7?.whoAttends || ""}
  Frequency           : ${s.section7?.frequency || ""}
  Barriers            : ${s.section7?.barriers || ""}

SECTION 8 — AUTHORIZATION FLAGS
  Request Type          : ${s.section8?.requestType || ""}
  Prior Auth Number     : ${s.section8?.priorAuthNumber || ""}
  Prior Service Dates   : ${s.section8?.priorDates || ""}
  Special Notes         : ${s.section8?.notes || ""}
  MUE Compliance        : ${s.section8?.mueCompliance || ""}

SECTION 9 — MEDICAL NECESSITY SUMMARY (LMN)
${bullet(s.section9?.bullets)}

  Physician Signature : ${s.section9?.physicianSignature || "[BCBA to obtain before submission]"}
  BCBA Signature      : ${s.section9?.bcbaSignature || "[Required]"}

SECTION 10 — PRE-SUBMISSION CHECKLIST
${check(s.section10?.checklist)}

SECTION 11 — AURACOMPLY AI ALIGNMENT
${bullet(s.section11?.bullets)}

══════════════════════════════════════════════════════════
--- AURACOMPLY DRAFT — Clinician review required before submission. ---`;
};

// ═══════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export default async (req, context) => {

  // ── 1. Method guard ────────────────────────────────────────────────────
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // ── 2. Auth guard ──────────────────────────────────────────────────────
  // DEV_MODE=true in Netlify env vars bypasses Netlify Identity for testing.
  // Set DEV_MODE=false (or remove it) before going live with real users.
  const DEV_MODE = process.env.DEV_MODE === "true";
  const netlifyUser = context?.clientContext?.user;

  if (!DEV_MODE && !netlifyUser) {
    return Response.json(
      { error: "Unauthorized. Please sign in.", status: "auth_error" },
      { status: 401 }
    );
  }

  // Use real identity if available, otherwise use dev placeholder
  const userEmail = netlifyUser?.email || "dev-test@auracomply.ai";
  const userName  = netlifyUser?.user_metadata?.full_name || "Dev Test User";

  // ── 3. Generate request ID for audit trail ─────────────────────────────
  const requestId = `pa-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {

    // ── 4. Parse and validate body ────────────────────────────────────────
    let body;
    try {
      body = await req.json();
    } catch {
      return Response.json(
        { error: "Invalid JSON body", status: "validation_error", requestId },
        { status: 400 }
      );
    }

    const { patientData, payer, state, payerType } = body;

    const missing = REQUIRED_PATIENT_FIELDS.filter(f => !patientData?.[f]);
    if (missing.length > 0) {
      return Response.json({
        error:     `Missing required fields: ${missing.join(", ")}`,
        status:    "validation_error",
        requestId,
      }, { status: 400 });
    }

    if (!payer || !state) {
      return Response.json({
        error:     "payer and state are required.",
        status:    "validation_error",
        requestId,
      }, { status: 400 });
    }

    const sanitize = (v) => typeof v === "string" ? v.replace(/<[^>]*>/g, "").slice(0, 500) : v;
    const safeP    = Object.fromEntries(Object.entries(patientData).map(([k, v]) => [k, sanitize(v)]));

    // ── 5. MUE pre-check ─────────────────────────────────────────────────
    const hrsPerWeek = parseFloat(safeP.hoursPerWeek) || 0;
    const hrsPerDay  = hrsPerWeek / 5;
    const mueBreached = hrsPerDay > DAILY_HOUR_CAP;

    // ── 6. Build messages and call Claude ─────────────────────────────────
    const systemPrompt = buildSystemPrompt(payer, state, payerType || "Medicaid");
    const userPrompt   = buildUserPrompt({ ...body, patientData: safeP }, userEmail);

    const messages = [
      { role: "user",      content: userPrompt },
      { role: "assistant", content: "{" },
    ];

    const { text, usage } = await callClaude(messages, systemPrompt);
    const fullText = "{" + text;

    // ── 7. Parse JSON ─────────────────────────────────────────────────────
    const structured = safeParseJSON(fullText);

    if (!structured) {
      return Response.json({
        draft:       fullText,
        structured:  null,
        status:      "success_raw",
        warning:     "JSON parse failed — raw text returned. Review manually.",
        payer, state, payerType,
        requestId,
        generatedBy: userEmail,
        generatedAt: new Date().toISOString(),
        meta:        { model: MODEL, inputTokens: usage?.input_tokens, outputTokens: usage?.output_tokens },
      });
    }

    // ── 8. Format readable draft text ─────────────────────────────────────
    const draft = formatDraft(structured, payer, state);

    // ── 9. Build payer-rule summary for frontend display ──────────────────
    const payerKey  = (payer || "").toLowerCase();
    const payerRule = PAYER_RULES[payerKey];
    const payerMeta = payerRule ? {
      label:          payerRule.label,
      portal:         payerRule.portal,
      turnaround:     payerRule.turnaroundDays,
      renewalMonths:  payerRule.renewalMonths,
      requiresMdOrder:payerRule.requiresMdOrder,
    } : null;

    // ── 10. Return enriched response ──────────────────────────────────────
    return Response.json({
      draft,
      structured,
      status:       "success",
      payer, state, payerType,
      mueWarning:   mueBreached
        ? `Requested ${hrsPerWeek} hrs/week = ${hrsPerDay.toFixed(1)} hrs/day — exceeds ${DAILY_HOUR_CAP} hr/day cap. Review Section 8.`
        : null,
      payerMeta,
      requestId,
      generatedBy:  userEmail,
      generatedAt:  new Date().toISOString(),
      meta: {
        model:        MODEL,
        inputTokens:  usage?.input_tokens,
        outputTokens: usage?.output_tokens,
      },
    });

  } catch (err) {
    console.error(`[generate-pa] requestId=${requestId} user=${userEmail} error=${err.message}`);
    return Response.json({
      error:     "Server error generating PA draft.",
      detail:    err.message,
      status:    "server_error",
      requestId,
    }, { status: 500 });
  }
};

export const config = { path: "/api/generate-pa" };