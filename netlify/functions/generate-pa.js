// netlify/functions/generate-pa.js
// SECURITY: API key via process.env only — never expose to client

// ═══════════════════════════════════════════════════════
// PAYER RULES
// ═══════════════════════════════════════════════════════

const PAYER_RULES = {
  medicaid: `
    MEDICAID ABA PA RULES:
    - Governed by EPSDT — must cover medically necessary ABA for children under 21
    - CPTs requiring PA: 97153, 97154, 97155, 97156, 97157, 97158
    - Hard cap: 8 hours per day combined across all ABA codes
    - 97153: max 40 units per week (10 hours)
    - 97155: max 8 units per day, BCBA must be present
    - 97156: max 8 units per week (2 hours) for family guidance
    - Required: VB-MAPP or ABLLS-R within 6 months, DSM-5 ASD diagnosis,
      FBA for behavior reduction goals, 6-month treatment plan signed by BCBA
    - Modifiers: HO (BCBA supervision), HN (bachelor level),
      95 (telehealth), GT (some states use GT instead of 95)
    - Renewal: every 6 months with progress data
    - Medicaid ID required on every PA form
  `,
  anthem: `
    ANTHEM ABA PA RULES:
    - CPTs requiring PA: 97153, 97155 always. 97156 bundled in most plans
    - 97153: PA required for more than 10 hours per week
    - 97155: max 8 hours per week without peer review
    - 97156: max 2 hours per week
    - Hard cap: 8 hours per day combined
    - Required: ASD diagnosis within 3 years, EIBI documentation for children under 7,
      BCBA credentials and state license number, progress notes last 6 months if renewal
    - Modifiers: HO for BCBA supervision, 95 for telehealth
    - Portal: Availity
    - Auth turnaround: 3 to 5 business days standard, 1 day urgent
  `,
  uhc: `
    UNITEDHEALTHCARE ABA PA RULES:
    - CPTs requiring PA: all of 97153 through 97158
    - 97153: peer review triggered above 30 hours per week
    - 97155: requires MD or DO order on file, max 8 hours per week
    - 97156: max 4 hours per week
    - Hard cap: 8 hours per day combined
    - Required: UHC-credentialed provider, FBA for all new auths,
      active BACB certification, MD order for 97155
    - Modifiers: HO for BCBA level, 95 for telehealth
    - Portal: uhcprovider.com
    - Auth turnaround: 3 business days standard, 24 hours urgent
  `,
  bcbs: `
    BCBS ABA PA RULES:
    - Note: BCBS varies by state affiliate — confirm with specific plan
    - CPTs requiring PA: all of 97153 through 97158
    - Behavioral health auth is separate from medical
    - 97153: up to 40 hours per week with justification
    - 97156: typically 2 to 4 hours per week
    - Hard cap: 8 hours per day MUE limit
    - Required: BCBA license verification, ASD diagnosis within 2 to 3 years,
      individualized treatment plan with SMART goals, FBA for behavior reduction
    - Modifiers: HO for BCBA supervision, 95 for telehealth
  `,
  aetna: `
    AETNA ABA PA RULES:
    - CPTs requiring PA: all of 97153 through 97158
    - Aetna uses their own Behavioral Health PA form
    - 97153: up to 40 hours per week with strong clinical justification
    - 97155: max 8 hours per week without peer review
    - 97156: max 2 hours per week standard
    - Hard cap: 8 hours per day combined
    - Required: DSM-5 ASD diagnosis confirmed not suspected, evaluation report,
      FBA for behavior reduction goals, BCBA credentials, physician referral on file
    - Diagnosis must be within 2 years
    - Common denials: missing FBA, diagnosis not confirmed, hours exceed threshold
    - Modifiers: HO for BCBA services, 95 for telehealth
    - Portal: Availity or NaviMedix
    - Auth turnaround: 3 business days standard, 1 day urgent
  `,
  cigna: `
    CIGNA ABA PA RULES:
    - CPTs requiring PA: 97153, 97155 always. 97156 bundled in most plans
    - Hard cap: 8 hours per day combined
    - Modifiers: HO, 95 standard
    - Required: BCBA credentials, ASD diagnosis, treatment plan
    - State-specific rule — confirm with payer policy for exact caps
  `,
  molina: `
    MOLINA HEALTHCARE ABA PA RULES:
    - Medicaid MCO — EPSDT applies for members under 21
    - CPTs requiring PA: all of 97153 through 97158
    - Hard cap: 8 hours per day combined
    - Required: VB-MAPP or ABLLS-R, DSM-5 diagnosis, treatment plan, BCBA credentials
    - Modifiers: HO, 95 or GT depending on state
    - State specific rules — confirm with your state Molina plan
  `
};

// ═══════════════════════════════════════════════════════
// SYSTEM PROMPT
// ═══════════════════════════════════════════════════════

const buildSystemPrompt = (payer, state, payerType) => {
  const rules = PAYER_RULES[payer.toLowerCase()] ||
    `Payer: ${payer} | State: ${state} | Type: ${payerType}. Confirm rules with payer policy.`;

  return `You are an ABA prior authorization specialist for AuraComply AI.
STATE: ${state} | PAYER: ${payer} | TYPE: ${payerType}

PAYER RULES:
${rules}

CPT CODES:
97153=Individual DTT | 97154=Group DTT | 97155=BCBA Protocol Mod
97156=Family Training | 97157=Multi-Family Group | 97158=Group w/Protocol

ICD-10: F84.0=Autistic Disorder | F84.5=Asperger | F84.8=Other PDD | F84.9=PDD NOS

RULES:
- Hard cap: 8 hrs/day combined (97153+97154+97155+97158)
- Units = 15 min increments
- Never invent rules — mark unknowns as "confirm with payer"
- End every response: --- AURACOMPLY DRAFT — Clinician review required before submission. ---

Output valid JSON matching this exact structure — no extra keys, no missing keys:
{
  "section1":  { "header":"", "bullets":["","","","",""] },
  "section2":  { "memberId":"", "dob":"", "age":"", "gender":"", "address":"", "payerType":"", "payerName":"", "planId":"" },
  "section3":  { "cpt":"", "description":"", "unitsPerWeek":0, "unitsPerMonth":0, "unitType":"15 min", "hrsPerDay":0, "hrsPerWeek":0, "effectiveDates":"", "authType":"" },
  "section4":  { "bcbaName":"", "bcbaLicense":"", "bcbaNpi":"", "physician":"", "physicianNpi":"", "clinic":"", "clinicNpi":"", "enrollmentStatus":"" },
  "section5":  { "icd10":"", "diagnosisDate":"", "diagnosticTool":"", "assessmentMethod":"", "assessmentDate":"", "keyFindings":["","",""], "impairments":{"communication":"","social":"","adl":"","safety":"","behavior":""}, "goals":["","","","","","",""] },
  "section6":  { "placeOfService":"", "telehealth":"", "telehealthModifier":"", "payerTelehealthNote":"" },
  "section7":  { "units97156":0, "units97157":0, "whoAttends":"", "frequency":"", "barriers":"" },
  "section8":  { "requestType":"", "priorAuthNumber":"", "priorDates":"", "notes":"", "mueCompliance":"" },
  "section9":  { "bullets":["","","","","","",""], "physicianSignature":"", "bcbaSignature":"" },
  "section10": { "checklist":["","","","",""] },
  "section11": { "bullets":["","","","",""] }
}`;
};

// ═══════════════════════════════════════════════════════
// MESSAGE HELPERS
// ═══════════════════════════════════════════════════════

const add_user_message = (messages, prompt) => {
  messages.push({ role: "user", content: prompt });
};

const add_assistant_message = (messages, prefill) => {
  messages.push({ role: "assistant", content: prefill });
};

// ═══════════════════════════════════════════════════════
// BUILD USER PROMPT
// ═══════════════════════════════════════════════════════

const buildUserPrompt = (body) => {
  const {
    patientData: p,
    payer, state, payerType, payerName,
    authType, clinicianNotes, isMedicaidArmed
  } = body;

  return `Generate PA JSON for all 11 sections:

state=${state}
payer=${payer}
payer_type=${payerType || "Medicaid"}
payer_name=${payerName || payer}
auth_type=${authType || "initial"}
medicaid_armed=${isMedicaidArmed || "yes"}

patient:
  id=${p.insuranceId || ""}
  name=${p.name}
  dob=${p.dob}
  gender=${p.gender || ""}
  address=${p.address || ""}

diagnosis:
  icd10=${p.diagnosis}
  date=${p.diagnosisDate || ""}
  tool=${p.diagnosticTool || ""}

assessment:
  type=${p.assessmentType || "VB-MAPP"}
  vbmapp=${p.vbmapp || ""}
  abllsr=${p.abllsr || ""}
  vineland=${p.vineland || ""}
  date=${p.assessDate || ""}

provider:
  bcba=${p.bcbaName || ""}
  license=${p.bcbaLicense || ""}
  bcba_npi=${p.bcbaNpi || ""}
  physician=${p.supervisingMd || ""}
  clinic=${p.clinicName || ""}
  clinic_npi=${p.clinicNpi || ""}

service:
  cpt=${p.cptCode}
  hrs_per_week=${p.hoursPerWeek || ""}
  weeks=${p.weeks}
  start=${p.startDate || ""}
  setting=${p.setting || "Home"}
  telehealth=${p.telehealth || "No"}
  prior_auth=${p.priorAuthNumber || "N/A"}

notes=${clinicianNotes || "See clinical documentation."}`;
};

// ═══════════════════════════════════════════════════════
// CHAT — calls Claude API
// ═══════════════════════════════════════════════════════

const chat = async (messages, systemPrompt) => {
  const claudeResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:          "claude-haiku-4-5",
      max_tokens:     4096,
      system:         systemPrompt,
      messages:       messages,
      stop_sequences: ["```"],
    }),
  });

  if (!claudeResponse.ok) {
    const errText = await claudeResponse.text();
    throw new Error(`Claude API ${claudeResponse.status}: ${errText.slice(0, 300)}`);
  }

  const data = await claudeResponse.json();
  const text = (data?.content?.[0]?.text || "").trim();
  return { text, usage: data.usage };
};

// ═══════════════════════════════════════════════════════
// SAFE JSON PARSER
// ═══════════════════════════════════════════════════════

const safeParseJSON = (text) => {
  try {
    const cleaned = text
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/gi, "")
      .trim();
    const start = cleaned.indexOf("{");
    const end   = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object found");
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

// ═══════════════════════════════════════════════════════
// FORMAT STRUCTURED JSON INTO READABLE DRAFT TEXT
// ═══════════════════════════════════════════════════════

const formatDraft = (s, payer, state) => {
  try {
    return `PRIOR AUTHORIZATION DRAFT — AuraComply AI
═══════════════════════════════════════════════

SECTION 1 — PRIOR AUTHORIZATION HEADER
${s.section1?.header || ""}
${(s.section1?.bullets || []).map((b, i) => `• ${b}`).join("\n")}

SECTION 2 — PATIENT METADATA
Medicaid ID / Member ID: ${s.section2?.memberId || ""}
Date of Birth: ${s.section2?.dob || ""}
Age: ${s.section2?.age || ""}
Gender: ${s.section2?.gender || ""}
Address: ${s.section2?.address || ""}
Payer Type: ${s.section2?.payerType || ""}
Payer Name: ${s.section2?.payerName || ""}
Plan ID: ${s.section2?.planId || ""}

SECTION 3 — SERVICE DATA BY CPT
CPT Code: ${s.section3?.cpt || ""}
Service Description: ${s.section3?.description || ""}
Units Per Week: ${s.section3?.unitsPerWeek || ""}
Units Per Month: ${s.section3?.unitsPerMonth || ""}
Unit Type: ${s.section3?.unitType || "15 min"}
Hours Per Day: ${s.section3?.hrsPerDay || ""}
Hours Per Week: ${s.section3?.hrsPerWeek || ""}
Effective Dates: ${s.section3?.effectiveDates || ""}
Authorization Type: ${s.section3?.authType || ""}

SECTION 4 — PROVIDER AND CREDENTIALING
Rendering BCBA: ${s.section4?.bcbaName || ""}
BCBA License: ${s.section4?.bcbaLicense || ""}
BCBA NPI: ${s.section4?.bcbaNpi || ""}
Supervising Physician: ${s.section4?.physician || ""}
Physician NPI: ${s.section4?.physicianNpi || ""}
Clinic / Agency: ${s.section4?.clinic || ""}
Clinic NPI: ${s.section4?.clinicNpi || ""}
Enrollment Status: ${s.section4?.enrollmentStatus || ""}

SECTION 5 — CLINICAL DOCUMENTATION
ICD-10 Diagnosis: ${s.section5?.icd10 || ""}
Date of Diagnosis: ${s.section5?.diagnosisDate || ""}
Diagnostic Tool: ${s.section5?.diagnosticTool || ""}
Assessment Method: ${s.section5?.assessmentMethod || ""}
Assessment Date: ${s.section5?.assessmentDate || ""}

Key Findings:
${(s.section5?.keyFindings || []).map((f, i) => `• ${f}`).join("\n")}

Functional Impairments:
- Communication: ${s.section5?.impairments?.communication || ""}
- Social Interaction: ${s.section5?.impairments?.social || ""}
- Activities of Daily Living: ${s.section5?.impairments?.adl || ""}
- Safety: ${s.section5?.impairments?.safety || ""}
- Behavior: ${s.section5?.impairments?.behavior || ""}

Treatment Plan Goals:
${(s.section5?.goals || []).map((g, i) => `${i + 1}. ${g}`).join("\n")}

SECTION 6 — SETTING AND MODALITY
Place of Service: ${s.section6?.placeOfService || ""}
Telehealth: ${s.section6?.telehealth || ""}
Telehealth Modifier: ${s.section6?.telehealthModifier || ""}
Payer Telehealth Note: ${s.section6?.payerTelehealthNote || ""}

SECTION 7 — PARENT AND CAREGIVER INVOLVEMENT
97156 Units Per Month: ${s.section7?.units97156 || ""}
97157 Units Per Month: ${s.section7?.units97157 || ""}
Who Attends: ${s.section7?.whoAttends || ""}
Frequency: ${s.section7?.frequency || ""}
Barriers: ${s.section7?.barriers || ""}

SECTION 8 — AUTHORIZATION FLAGS
Request Type: ${s.section8?.requestType || ""}
Prior Authorization Number: ${s.section8?.priorAuthNumber || ""}
Prior Service Dates: ${s.section8?.priorDates || ""}
Special Notes: ${s.section8?.notes || ""}
MUE Compliance: ${s.section8?.mueCompliance || ""}

SECTION 9 — MEDICAL NECESSITY SUMMARY
${(s.section9?.bullets || []).map((b, i) => `• ${b}`).join("\n")}

Physician Signature: ${s.section9?.physicianSignature || ""}
BCBA Signature: ${s.section9?.bcbaSignature || ""}

SECTION 10 — PRE-SUBMISSION CHECKLIST
${(s.section10?.checklist || []).map(c => `☐ ${c}`).join("\n")}

SECTION 11 — AURACOMPLY AI ALIGNMENT
${(s.section11?.bullets || []).map((b, i) => `• ${b}`).join("\n")}

═══════════════════════════════════════════════
--- AURACOMPLY DRAFT — Clinician review required before submission. ---`;
  } catch {
    return "Error formatting draft. Raw data available in structured field.";
  }
};

// ═══════════════════════════════════════════════════════
// MAIN FUNCTION
// ═══════════════════════════════════════════════════════

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const { patientData, payer, state, payerType } = body;

    // Validate required fields
    const required = ["name", "dob", "diagnosis", "cptCode", "weeks"];
    const missing  = required.filter(f => !patientData?.[f]);
    if (missing.length > 0) {
      return Response.json({
        error:  `Missing required fields: ${missing.join(", ")}`,
        status: "validation_error"
      }, { status: 400 });
    }

    if (!payer || !state) {
      return Response.json({
        error:  "Payer and state are required.",
        status: "validation_error"
      }, { status: 400 });
    }

    // Build messages
    const messages = [];
    add_user_message(messages, buildUserPrompt(body));
    add_assistant_message(messages, "```json");

    // Call Claude
    const systemPrompt = buildSystemPrompt(payer, state, payerType || "Medicaid");
    const { text, usage } = await chat(messages, systemPrompt);

    if (!text) {
      return Response.json({
        error:  "Claude returned empty response",
        status: "api_error"
      }, { status: 500 });
    }

    // Parse JSON
    const structured = safeParseJSON(text);

    if (!structured) {
      return Response.json({
        draft:       text,
        structured:  null,
        status:      "success_raw",
        warning:     "JSON parse failed — returning raw text.",
        payer, state, payerType,
        generatedAt: new Date().toISOString(),
        meta: {
          model:        "claude-haiku-4-5",
          inputTokens:  usage?.input_tokens,
          outputTokens: usage?.output_tokens
        }
      });
    }

    // Format structured JSON into readable draft text
    const draft = formatDraft(structured, payer, state);

    return Response.json({
      draft,
      structured,
      status:      "success",
      payer, state, payerType,
      generatedAt: new Date().toISOString(),
      meta: {
        model:        "claude-haiku-4-5",
        inputTokens:  usage?.input_tokens,
        outputTokens: usage?.output_tokens
      }
    });

  } catch (err) {
    console.error("Function error:", err.message);
    return Response.json({
      error:  "Server error",
      detail: err.message,
      status: "server_error"
    }, { status: 500 });
  }
};

export const config = { path: "/api/generate-pa" };