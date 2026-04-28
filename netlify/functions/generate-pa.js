// netlify/functions/generate-pa.js
// SECURITY: API key via process.env only — never expose to client

const PAYER_RULES = {
  medicaid: `
    MEDICAID RULES: EPSDT governs — must cover ABA for children under 21.
    CPTs requiring PA: 97153, 97154, 97155, 97156, 97157, 97158.
    Hard cap: 8 hours per day combined across all codes.
    97153: max 40 units per week. 97155: BCBA must be present.
    97156: max 8 units per week family guidance.
    Required: VB-MAPP or ABLLS-R within 6 months, DSM-5 ASD diagnosis,
    FBA for behavior reduction, 6-month treatment plan signed by BCBA.
    Modifiers: HO (BCBA supervision), 95 (telehealth).
    Renewal: every 6 months with progress data.
  `,
  anthem: `
    ANTHEM RULES: PA required for 97153 over 10hrs/week, 97155 always.
    97155: max 8 hours per week. 97156: max 2 hours per week.
    Hard cap: 8 hours per day combined.
    Required: ASD diagnosis within 3 years, BCBA credentials,
    progress notes last 6 months if renewal.
    Modifiers: HO, 95. Portal: Availity.
  `,
  uhc: `
    UHC RULES: All 97153-97158 require PA.
    97155: requires MD or DO order on file.
    Hard cap: 8 hours per day combined.
    Required: UHC-credentialed provider, FBA for all new auths,
    active BACB certification, MD order for 97155.
    Modifiers: HO, 95. Portal: uhcprovider.com.
  `,
  bcbs: `
    BCBS RULES: Varies by state — confirm with specific state plan.
    All 97153-97158 require PA. Behavioral health auth is separate.
    Hard cap: 8 hours per day MUE limit.
    Required: BCBA license, ASD diagnosis within 2-3 years, SMART goals.
    Modifiers: HO, 95.
  `,
  aetna: `
    AETNA RULES: All 97153-97158 require PA. Use Aetna-specific form.
    97153: up to 40 hours per week with justification.
    97155: max 8 hours per week without peer review.
    97156: max 2 hours per week. Hard cap: 8 hours per day combined.
    Required: DSM-5 confirmed ASD, evaluation report, FBA, physician referral.
    Common denials: missing FBA, hours exceed threshold, diagnosis not confirmed.
    Modifiers: HO, 95. Portal: Availity.
  `,
  cigna: `
    CIGNA RULES: 97153 and 97155 always require PA.
    Hard cap: 8 hours per day combined. Modifiers: HO, 95.
    Required: BCBA credentials, ASD diagnosis, treatment plan.
  `,
  molina: `
    MOLINA RULES: Medicaid MCO — EPSDT applies for members under 21.
    All 97153-97158 require PA. Hard cap: 8 hours per day combined.
    Required: VB-MAPP, ABLLS-R, DSM-5, BCBA credentials.
    Modifiers: HO, 95 or GT depending on state.
  `
};

const buildSystemPrompt = (payer, state, payerType) => {
  const rules = PAYER_RULES[payer.toLowerCase()] ||
    `Payer: ${payer} | State: ${state} | Confirm rules with payer policy.`;

  return `You are a cross-payer ABA prior authorization specialist
for AuraComply AI. Generate a complete structured PA block for
CPT codes 97153 through 97158.

STATE: ${state} | PAYER TYPE: ${payerType} | PAYER: ${payer}

PAYER RULES FOR THIS REQUEST:
${rules}

CPT CODE DEFINITIONS:
97153: Individual DTT 1 to 1
97154: Group DTT
97155: Protocol modification by BCBA direct supervision
97156: Family and caregiver training 1 to 1
97157: Multi-family group training
97158: Group adaptive behavior treatment with protocol modification

ICD-10 CODES:
F84.0: Autistic Disorder
F84.5: Asperger Syndrome
F84.8: Other Pervasive Developmental Disorders
F84.9: PDD Unspecified

CRITICAL RULES:
- Hard cap: 8 hours per day combined for 97153 plus 97154 plus 97155 plus 97158
- Units are 15 minute increments
- Never invent rules — mark unknowns as state or payer specific rule to be confirmed
- End every response with:
  --- AURACOMPLY DRAFT — Clinician review required before submission. ---

OUTPUT ALL 11 SECTIONS EXACTLY AS BELOW:

SECTION 1 — PRIOR AUTHORIZATION HEADER
Write: Prior Authorization – State: ${state} | Payer Type: ${payerType} | Payer: ${payer}
List 5 bullets: CPTs requiring PA, unit caps, modifiers, telehealth rules, auth period.

SECTION 2 — PATIENT METADATA
- Medicaid ID or Member ID:
- DOB:
- Age:
- Gender:
- Address:
- Payer Type:
- Payer Name:
- Plan ID:

SECTION 3 — SERVICE DATA BY CPT
- CPT:
- Service description:
- Units per week:
- Units per month:
- Unit type: 15 minute increments
- Hours per day:
- Hours per week:
- Effective dates:
- Authorization type:

SECTION 4 — PROVIDER AND CREDENTIALING
- BCBA name:
- BCBA license:
- BCBA NPI:
- Supervising physician:
- Supervising physician NPI:
- Clinic name:
- Clinic NPI:
- Enrollment status:

SECTION 5 — CLINICAL DOCUMENTATION
DIAGNOSIS:
- ICD-10:
- Date of diagnosis:
- Diagnostic tool:

ASSESSMENT:
- Method:
- Date:
- Key findings 3 bullets

FUNCTIONAL IMPAIRMENTS 5 bullets with severity level each:
- Communication:
- Social interaction:
- Activities of daily living:
- Safety:
- Behavior:

TREATMENT PLAN GOALS 7 numbered SMART goals:
1. Communication goal
2. Social goal
3. Adaptive behavior goal
4. Behavior reduction goal
5. Parent training goal
6. Generalization goal
7. Safety goal

SECTION 6 — SETTING AND MODALITY
- Place of service:
- Telehealth used:
- Telehealth modifier:
- Payer telehealth notes:

SECTION 7 — PARENT AND CAREGIVER INVOLVEMENT
- 97156 units per month:
- 97157 units per month:
- Who attends:
- Frequency:
- Barriers:

SECTION 8 — AUTHORIZATION FLAGS
- Request type:
- Prior auth number if renewal:
- MUE compliance: confirm all services within 8 hour per day cap.

SECTION 9 — MEDICAL NECESSITY SUMMARY
Write 7 bullets in Letter of Medical Necessity format:
- Diagnosis and time window
- Functional impact on safety school home and family
- Assessment findings with specific scores
- ABA treatment plan summary
- Rationale for ABA over other therapies
- Progress monitoring plan and expected outcomes
- Hours justification
End with signature placeholders for physician and BCBA.

SECTION 10 — PRE-SUBMISSION CHECKLIST
5 checkboxes:
☐ Diagnosis and assessment dates within payer allowed window
☐ Units and hours within payer caps and 8 hour day MUE confirmed
☐ Correct modifier and telehealth flag used
☐ Parent training CPTs 97156 and 97157 have family involvement narrative
☐ All signatures and NPIs complete and match credentialing on file

SECTION 11 — AURACOMPLY AI ALIGNMENT
5 bullets showing how AuraComply closes PA gaps across all 50 states and payers.`;
};

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const {
      patientData,
      payer,
      state,
      payerType,
      payerName,
      authType,
      clinicianNotes,
      isMedicaidArmed
    } = body;

    const required = ['name', 'dob', 'diagnosis', 'cptCode', 'weeks'];
    const missing = required.filter(f => !patientData?.[f]);
    if (missing.length > 0) {
      return Response.json({
        error: `Missing required fields: ${missing.join(', ')}`,
        status: "validation_error"
      }, { status: 400 });
    }

    if (!payer || !state) {
      return Response.json({
        error: "Payer and state are required.",
        status: "validation_error"
      }, { status: 400 });
    }

    const userPrompt = `
Generate a complete prior authorization using all 11 sections.

state: ${state}
payer_type: ${payerType || "Medicaid"}
payer_name: ${payerName || payer}
is_medicaid_armed: ${isMedicaidArmed || "yes"}
authorization_type: ${authType || "initial"}

patient_snapshot:
- Member ID: ${patientData.insuranceId || "TO-BE-FILLED"}
- Name: ${patientData.name}
- DOB: ${patientData.dob}
- Gender: ${patientData.gender || "TO-BE-FILLED"}
- Address: ${patientData.address || "TO-BE-FILLED"}
- Diagnosis: ${patientData.diagnosis}
- Assessment type: ${patientData.assessmentType || "VB-MAPP"}
- VB-MAPP Level: ${patientData.vbmapp || "TO-BE-FILLED"}
- ABLLS-R Score: ${patientData.abllsr || "TO-BE-FILLED"}
- Vineland Score: ${patientData.vineland || "TO-BE-FILLED"}
- Assessment date: ${patientData.assessDate || "TO-BE-FILLED"}
- BCBA name: ${patientData.bcbaName || "TO-BE-FILLED"}
- BCBA license: ${patientData.bcbaLicense || "TO-BE-FILLED"}
- BCBA NPI: ${patientData.bcbaNpi || "TO-BE-FILLED"}
- Supervising physician: ${patientData.supervisingMd || "TO-BE-FILLED"}
- Clinic name: ${patientData.clinicName || "TO-BE-FILLED"}
- Clinic NPI: ${patientData.clinicNpi || "TO-BE-FILLED"}
- CPT code: ${patientData.cptCode}
- Hours per week: ${patientData.hoursPerWeek || "TO-BE-FILLED"}
- Duration: ${patientData.weeks} weeks
- Start date: ${patientData.startDate || "TO-BE-FILLED"}
- Setting: ${patientData.setting || "Home"}
- Telehealth: ${patientData.telehealth || "No"}
- Clinical summary: ${clinicianNotes || "See clinical documentation."}

Generate all 11 sections now.`;

    const claudeResponse = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: buildSystemPrompt(
            payer,
            state,
            payerType || "Medicaid"
          ),
          messages: [
            { role: "user", content: userPrompt }
          ],
        }),
      }
    );

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error("Claude API error:", claudeResponse.status);
      return Response.json({
        error: `Claude API error ${claudeResponse.status}`,
        detail: errData.error?.message || "Check API key and billing at console.anthropic.com",
        status: "api_error"
      }, { status: 500 });
    }

    const claudeData = await claudeResponse.json();
    const paDraft = claudeData.content[0].text;

    return Response.json({
      draft: paDraft,
      status: "success",
      payer: payer,
      state: state,
      payerType: payerType,
      generatedAt: new Date().toISOString(),
      meta: {
        model: "claude-sonnet-4-20250514",
        inputTokens: claudeData.usage?.input_tokens,
        outputTokens: claudeData.usage?.output_tokens
      }
    });

  } catch (err) {
    console.error("Function error:", err.message);
    return Response.json({
      error: "Server error",
      detail: err.message,
      status: "server_error"
    }, { status: 500 });
  }
};

export const config = { path: "/api/generate-pa" };