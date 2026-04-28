// netlify/functions/validate-pa.js
// SECURITY: API key via process.env only — never expose to client

// ═══════════════════════════════════════════════════════
// PAYER-SPECIFIC VALIDATION RULES
// Mirrors the same payers in generate-pa.js exactly
// ═══════════════════════════════════════════════════════

const PAYER_VALIDATION_RULES = {
  medicaid: {
    maxHoursPerDay: 8,
    maxUnits97153PerWeek: 40,
    maxUnits97155PerDay: 8,
    maxUnits97156PerWeek: 8,
    requiresFBA: true,
    requiresVBMAPP: true,
    requiresBCBASignature: true,
    requiresPhysicianSignature: true,
    diagnosisWindowYears: null,
    renewalMonths: 6,
    requiredModifiers: ["HO"],
    portalNote: "Medicaid state portal — confirm state-specific submission requirements",
    criticalDenialReasons: [
      "Missing VB-MAPP or ABLLS-R assessment within 6 months",
      "Missing DSM-5 ASD diagnosis documentation",
      "Missing FBA for behavior reduction goals",
      "Treatment plan not signed by BCBA",
      "Hours exceed 8 per day MUE cap",
      "Medicaid ID missing on PA form"
    ]
  },
  anthem: {
    maxHoursPerDay: 8,
    maxHours97153PerWeek: 10,
    maxHours97155PerWeek: 8,
    maxHours97156PerWeek: 2,
    requiresFBA: false,
    requiresVBMAPP: false,
    requiresBCBASignature: true,
    requiresPhysicianSignature: false,
    diagnosisWindowYears: 3,
    renewalMonths: 6,
    requiredModifiers: ["HO"],
    portalNote: "Submit via Availity. Turnaround: 3-5 business days standard, 1 day urgent.",
    criticalDenialReasons: [
      "ASD diagnosis older than 3 years",
      "97155 hours exceed 8 per week without peer review",
      "97156 hours exceed 2 per week",
      "BCBA state license number missing"
    ]
  },
  uhc: {
    maxHoursPerDay: 8,
    maxHours97153PeerReviewThreshold: 30,
    maxHours97155PerWeek: 8,
    maxHours97156PerWeek: 4,
    requiresFBA: true,
    requiresMDOrder97155: true,
    requiresBCBASignature: true,
    requiresPhysicianSignature: true,
    diagnosisWindowYears: null,
    renewalMonths: 6,
    requiredModifiers: ["HO"],
    portalNote: "Submit via uhcprovider.com. Turnaround: 3 business days standard, 24 hours urgent.",
    criticalDenialReasons: [
      "Missing MD or DO order for 97155",
      "Missing FBA for new authorization",
      "BACB certification not active or not on file",
      "Provider not UHC-credentialed",
      "97153 over 30 hours per week without peer review justification"
    ]
  },
  bcbs: {
    maxHoursPerDay: 8,
    maxHours97153PerWeek: 40,
    maxHours97156PerWeek: 4,
    requiresFBA: true,
    requiresBCBASignature: true,
    requiresPhysicianSignature: false,
    diagnosisWindowYears: 3,
    renewalMonths: 6,
    requiredModifiers: ["HO"],
    portalNote: "BCBS varies by state affiliate — confirm with specific state plan before submission.",
    criticalDenialReasons: [
      "ASD diagnosis older than 2-3 years (state dependent)",
      "Treatment plan goals not in SMART format",
      "FBA missing for behavior reduction goals",
      "Behavioral health auth submitted through medical — must be separate"
    ]
  },
  aetna: {
    maxHoursPerDay: 8,
    maxHours97153PerWeek: 40,
    maxHours97155PerWeek: 8,
    maxHours97156PerWeek: 2,
    requiresFBA: true,
    requiresPhysicianReferral: true,
    requiresBCBASignature: true,
    requiresPhysicianSignature: true,
    diagnosisWindowYears: 2,
    renewalMonths: 6,
    requiredModifiers: ["HO"],
    portalNote: "Submit via Availity or NaviMedix. Use Aetna-specific Behavioral Health PA form.",
    criticalDenialReasons: [
      "Diagnosis listed as suspected not confirmed DSM-5",
      "Missing FBA — most common denial reason",
      "ASD diagnosis older than 2 years",
      "Hours exceed peer-reviewed threshold without written justification",
      "Physician referral not on file"
    ]
  },
  cigna: {
    maxHoursPerDay: 8,
    requiresBCBASignature: true,
    requiredModifiers: ["HO"],
    portalNote: "State-specific rules apply — confirm with payer policy for exact caps.",
    criticalDenialReasons: [
      "Missing BCBA credentials",
      "ASD diagnosis not documented",
      "Treatment plan missing"
    ]
  },
  molina: {
    maxHoursPerDay: 8,
    requiresFBA: true,
    requiresVBMAPP: true,
    requiresBCBASignature: true,
    requiresPhysicianSignature: false,
    diagnosisWindowYears: null,
    renewalMonths: 6,
    requiredModifiers: ["HO"],
    portalNote: "Molina Medicaid MCO — EPSDT applies. State-specific rules apply.",
    criticalDenialReasons: [
      "Missing VB-MAPP or ABLLS-R assessment",
      "Missing DSM-5 ASD diagnosis",
      "BCBA credentials not verified",
      "Wrong telehealth modifier — confirm 95 vs GT for your state"
    ]
  }
};

// ═══════════════════════════════════════════════════════
// BUILD VALIDATOR SYSTEM PROMPT
// Matches the structure and style of buildSystemPrompt
// in generate-pa.js exactly
// ═══════════════════════════════════════════════════════

const buildValidatorPrompt = (payer, state, payerType) => {
  const rules = PAYER_VALIDATION_RULES[payer?.toLowerCase()] || null;

  const rulesText = rules
    ? `
PAYER-SPECIFIC RULES FOR ${payer.toUpperCase()}:
- Max hours per day: ${rules.maxHoursPerDay} (MUE hard cap)
- FBA required: ${rules.requiresFBA ? "YES — critical" : "No"}
- VB-MAPP required: ${rules.requiresVBMAPP ? "YES" : "No"}
- BCBA signature required: ${rules.requiresBCBASignature ? "YES" : "No"}
- Physician signature required: ${rules.requiresPhysicianSignature ? "YES" : "No"}
- Diagnosis window: ${rules.diagnosisWindowYears ? rules.diagnosisWindowYears + " years" : "No hard expiry — must be current"}
- Required modifiers: ${rules.requiredModifiers?.join(", ") || "HO standard"}
- Portal note: ${rules.portalNote}

TOP DENIAL REASONS FOR ${payer.toUpperCase()} — CHECK THESE FIRST:
${rules.criticalDenialReasons.map((r, i) => `${i + 1}. ${r}`).join("\n")}
`
    : `Payer: ${payer} | State: ${state} | Apply general ABA PA compliance standards.`;

  return `You are AuraComply AI's senior ABA prior authorization compliance engine.
You have 15 years of ABA billing expertise across all 50 US states and every major payer.
Your validation catches every denial risk before submission.

STATE: ${state || "Not specified"}
PAYER TYPE: ${payerType || "Unknown"}
PAYER: ${payer || "Unknown"}

${rulesText}

CPT CODE DEFINITIONS:
- 97153: Adaptive Behavior Treatment by Protocol — individual 1 to 1 DTT
- 97154: Group Adaptive Behavior Treatment by Protocol — group DTT
- 97155: Protocol Modification by BCBA — BCBA direct supervision
- 97156: Family and Caregiver Training 1 to 1 — parent guidance
- 97157: Multi-Family Group Training — group caregiver training
- 97158: Group Adaptive Behavior Treatment with Protocol Modification

ICD-10 CODES:
- F84.0: Autistic Disorder (Classic Autism)
- F84.5: Asperger Syndrome
- F84.8: Other Pervasive Developmental Disorders
- F84.9: PDD Unspecified

UNIVERSAL ABA PA COMPLIANCE RULES (apply regardless of payer):
1. MUE CAP: 97153 plus 97154 plus 97155 plus 97158 combined CANNOT exceed 8 hours (32 units) per day
2. UNITS: All CPT codes bill in 15-minute increments
3. BCBA: 97155 requires BCBA direct supervision — validate credentials present
4. DIAGNOSIS: Must be DSM-5 confirmed ASD (F84.0, F84.5, F84.8, or F84.9) — not suspected
5. SMART GOALS: Treatment plan goals must be Specific, Measurable, Achievable, Relevant, Time-bound
6. FBA: Required by most payers for behavior reduction goals — flag if missing
7. NPI: Both rendering BCBA NPI and agency NPI must be present and distinct
8. MODIFIERS: HO required for BCBA-level services. 95 or GT for telehealth
9. 97156: Parent and caregiver training requires named family member — flag if vague
10. MEDICAL NECESSITY: Must demonstrate functional impairment in 3 or more domains

VALIDATE ALL 11 SECTIONS FROM THE DRAFT:
Section 1 — Prior Authorization Header: payer details, CPT list, caps, modifiers, auth period
Section 2 — Patient Metadata: all 8 fields present, no missing required fields
Section 3 — Service Data by CPT: units math correct, within payer caps, dates present
Section 4 — Provider and Credentialing: BCBA NPI, license, physician NPI, clinic NPI all present
Section 5 — Clinical Documentation: diagnosis confirmed, assessment scored, 5 impairment domains, 7 SMART goals
Section 6 — Setting and Modality: place of service documented, telehealth modifier if applicable
Section 7 — Parent and Caregiver Involvement: 97156 and 97157 units, named attendee, frequency documented
Section 8 — Authorization Flags: MUE compliance confirmed, prior auth number present if renewal
Section 9 — Medical Necessity Summary: 7 required bullets present, signature placeholders included
Section 10 — Pre-Submission Checklist: all 5 checkboxes present and addressed
Section 11 — AuraComply AI Alignment: 5 bullets present

SCORING RUBRIC:
90 to 100: Ready to submit. All critical fields complete, no compliance gaps.
75 to 89: Minor gaps. 1 to 2 non-critical fields missing. Submit after quick fix.
60 to 74: Moderate risk. Multiple missing fields. Likely denial without revision.
40 to 59: High risk. Critical fields missing. Do not submit without major revision.
0 to 39: Critical failure. Missing diagnosis, credentials, or MUE violation. Do not submit.

SEVERITY LEVELS FOR FINDINGS:
CRITICAL — Will cause denial or legal risk. Block submission.
WARNING — May cause delay or medical review. Fix before submitting.
SUGGESTION — Best practice improvement. Optional but recommended.

CRITICAL INSTRUCTION:
Return ONLY a valid JSON object.
No markdown. No backticks. No explanation. No preamble. Just the raw JSON.

Return this EXACT JSON structure:
{
  "ready": true or false,
  "score": 0 to 100,
  "scoreLabel": "Ready to Submit" or "Minor Gaps" or "Moderate Risk" or "High Risk" or "Critical Failure",
  "summary": "One sentence clinical summary of this PA draft quality",
  "payerSpecificAlert": "Top payer-specific denial risk found, or null if none",
  "sections": {
    "section1": { "pass": true or false, "note": "brief finding" },
    "section2": { "pass": true or false, "note": "brief finding" },
    "section3": { "pass": true or false, "note": "brief finding" },
    "section4": { "pass": true or false, "note": "brief finding" },
    "section5": { "pass": true or false, "note": "brief finding" },
    "section6": { "pass": true or false, "note": "brief finding" },
    "section7": { "pass": true or false, "note": "brief finding" },
    "section8": { "pass": true or false, "note": "brief finding" },
    "section9": { "pass": true or false, "note": "brief finding" },
    "section10": { "pass": true or false, "note": "brief finding" },
    "section11": { "pass": true or false, "note": "brief finding" }
  },
  "errors": [
    {
      "severity": "CRITICAL",
      "section": "Section number or name",
      "field": "exact field name",
      "issue": "exact problem description",
      "fix": "exact step-by-step fix instruction"
    }
  ],
  "warnings": [
    {
      "severity": "WARNING",
      "section": "Section number or name",
      "field": "exact field name",
      "issue": "exact problem description",
      "fix": "exact step-by-step fix instruction"
    }
  ],
  "suggestions": [
    {
      "severity": "SUGGESTION",
      "section": "Section number or name",
      "tip": "best practice improvement tip"
    }
  ],
  "mueCompliance": {
    "pass": true or false,
    "dailyHoursCap": 8,
    "detectedHours": "number detected or unknown",
    "note": "MUE compliance finding"
  },
  "credentialingCheck": {
    "bcbaPresent": true or false,
    "bcbaNpiPresent": true or false,
    "physicianPresent": true or false,
    "clinicNpiPresent": true or false,
    "note": "credentialing finding"
  },
  "diagnosisCheck": {
    "icd10Present": true or false,
    "confirmedNotSuspected": true or false,
    "withinPayerWindow": true or false or "unknown",
    "note": "diagnosis finding"
  },
  "smartGoalsCheck": {
    "goalsPresent": true or false,
    "goalCount": 0,
    "allSMART": true or false,
    "note": "goals finding"
  },
  "denialRiskFactors": [
    "top denial risk 1 found in this specific draft",
    "top denial risk 2 found in this specific draft",
    "top denial risk 3 found in this specific draft"
  ],
  "topPriorityFix": "The single most important thing to fix before submission",
  "estimatedApprovalProbability": "High (above 80%) or Moderate (50 to 79%) or Low (below 50%)",
  "portalSubmissionNote": "Payer portal name and turnaround time reminder"
}`;
};

// ═══════════════════════════════════════════════════════
// SAFE JSON PARSER
// Strips markdown fences, extracts clean JSON object
// ═══════════════════════════════════════════════════════

const safeParseJSON = (rawText) => {
  try {
    const cleaned = rawText
      .replace(/```json\s*/gi, "")
      .replace(/```\s*/gi, "")
      .trim();

    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end === -1) throw new Error("No JSON object found");

    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
};

// ═══════════════════════════════════════════════════════
// FALLBACK RESPONSE
// Returned when Claude parse fails — always valid JSON
// ═══════════════════════════════════════════════════════

const fallbackResponse = (payer, rawText) => ({
  ready: false,
  score: 0,
  scoreLabel: "Validation Error",
  summary: "Validation engine could not parse the PA draft. Please review manually.",
  payerSpecificAlert: payer
    ? `Check ${payer.toUpperCase()} payer portal for submission requirements.`
    : null,
  sections: Object.fromEntries(
    Array.from({ length: 11 }, (_, i) => [
      `section${i + 1}`,
      { pass: false, note: "Could not validate — review manually" }
    ])
  ),
  errors: [{
    severity: "CRITICAL",
    section: "All",
    field: "PA Draft",
    issue: "Validation engine could not parse the draft response.",
    fix: "Try regenerating the PA draft using generate-pa and then validate again."
  }],
  warnings: [],
  suggestions: [{
    severity: "SUGGESTION",
    section: "All",
    tip: "Ensure the draft was generated using AuraComply generate-pa before validating."
  }],
  mueCompliance: {
    pass: false,
    dailyHoursCap: 8,
    detectedHours: "unknown",
    note: "Could not check — resubmit after regenerating draft"
  },
  credentialingCheck: {
    bcbaPresent: false,
    bcbaNpiPresent: false,
    physicianPresent: false,
    clinicNpiPresent: false,
    note: "Could not check — resubmit after regenerating draft"
  },
  diagnosisCheck: {
    icd10Present: false,
    confirmedNotSuspected: false,
    withinPayerWindow: "unknown",
    note: "Could not check — resubmit after regenerating draft"
  },
  smartGoalsCheck: {
    goalsPresent: false,
    goalCount: 0,
    allSMART: false,
    note: "Could not check — resubmit after regenerating draft"
  },
  denialRiskFactors: [
    "Draft could not be parsed",
    "Manual review required",
    "Resubmit after regenerating draft"
  ],
  topPriorityFix: "Regenerate the PA draft using generate-pa and then validate again.",
  estimatedApprovalProbability: "Low (below 50%)",
  portalSubmissionNote: "Do not submit until validation passes.",
  _debug: rawText?.slice(0, 500) || "No raw text returned"
});

// ═══════════════════════════════════════════════════════
// MAIN FUNCTION
// Matches export style and error handling of generate-pa.js
// ═══════════════════════════════════════════════════════

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const { draft, payer, state, payerType } = body;

    // ── Validate required input ──
    if (!draft || typeof draft !== "string" || draft.trim().length < 100) {
      return Response.json({
        error: "No valid PA draft provided.",
        detail: "Generate a PA draft using generate-pa first, then pass the result here.",
        status: "validation_error"
      }, { status: 400 });
    }

    if (!payer || !state) {
      return Response.json({
        error: "Payer and state are required.",
        status: "validation_error"
      }, { status: 400 });
    }

    // ── Trim draft to stay within token limits ──
    const trimmedDraft = draft.length > 12000
      ? draft.slice(0, 12000) + "\n\n[DRAFT TRUNCATED FOR VALIDATION — full draft on file]"
      : draft;

    // ── Call Claude API ──
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
          max_tokens: 2048,
          system: buildValidatorPrompt(
            payer,
            state,
            payerType || "Medicaid"
          ),
          messages: [
            {
              role: "user",
              content: `Validate this ${payer || "Medicaid"} PA draft for ${state || "unspecified state"}.
Return ONLY the JSON object — no markdown, no explanation, just valid JSON.

PA DRAFT TO VALIDATE:
${trimmedDraft}`
            }
          ],
        }),
      }
    );

    // ── Handle non-OK response from Claude ──
    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      console.error("Claude API error status:", claudeResponse.status);
      return Response.json({
        error: "Claude API error",
        detail: errText.slice(0, 300),
        status: "api_error"
      }, { status: 500 });
    }

    // ── Parse Claude response ──
    const claudeData = await claudeResponse.json();
    const rawText = claudeData?.content?.[0]?.text || "";

    if (!rawText) {
      console.error("Claude returned empty content");
      return Response.json(fallbackResponse(payer, "empty response"), { status: 500 });
    }

    // ── Parse JSON from Claude ──
    const result = safeParseJSON(rawText);

    if (!result) {
      console.error("Could not parse Claude JSON. Raw:", rawText.slice(0, 500));
      return Response.json(fallbackResponse(payer, rawText), { status: 500 });
    }

    // ── Add portal note from local rules if Claude missed it ──
    const localRules = PAYER_VALIDATION_RULES[payer?.toLowerCase()];
    if (localRules?.portalNote && !result.portalSubmissionNote) {
      result.portalSubmissionNote = localRules.portalNote;
    }

    // ── Add metadata — matches generate-pa.js meta block style ──
    result.meta = {
      model: "claude-sonnet-4-20250514",
      payer: payer || "unknown",
      state: state || "unknown",
      payerType: payerType || "unknown",
      draftLength: draft.length,
      validatedAt: new Date().toISOString(),
      inputTokens: claudeData.usage?.input_tokens,
      outputTokens: claudeData.usage?.output_tokens
    };

    return Response.json({
      ...result,
      status: "success",
      payer: payer,
      state: state,
      payerType: payerType,
      generatedAt: new Date().toISOString()
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

export const config = { path: "/api/validate-pa" };