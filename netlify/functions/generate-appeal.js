// netlify/functions/generate-appeal.js
// SECURITY: API key via process.env only — never expose to client

const buildSystemPrompt = (payer) => `You are a senior ABA prior authorization appeals specialist
for AuraComply AI. Draft a complete, payer-ready appeal letter responding to a denied
prior authorization for ABA services (CPT 97153–97158).

PAYER: ${payer}

CRITICAL RULES:
- Address the specific denial code and stated reason directly.
- Anchor every clinical claim in evidence the user supplied — do NOT invent scores, dates, or credentials.
- Cite payer policy and EPSDT / Mental Health Parity / state Medicaid rules where relevant.
- Use formal letter structure with clear, numbered clinical arguments.
- Mark anything missing as TO-BE-FILLED rather than fabricating details.
- End the letter with:
  --- AURACOMPLY DRAFT — Clinician review required before submission. ---

OUTPUT THE LETTER WITH THESE SECTIONS:

1. HEADER
   - Date placeholder
   - Payer name and appeals address placeholder
   - Re: Member name / ID / DOB / denial reference

2. OPENING
   - Identify the denied service, denial code, and date of denial.
   - State that this is a formal request for reconsideration.

3. CLINICAL BACKGROUND
   - Diagnosis (ICD-10) and date.
   - Functional impairments tied to the requested service.
   - Assessment data (VB-MAPP, ABLLS-R, Vineland) when supplied.

4. MEDICAL NECESSITY ARGUMENT
   - 4–6 numbered points refuting the denial reason.
   - Tie each point back to payer policy or recognized clinical standard.

5. EVIDENCE SUMMARY
   - Bulleted list of attached documentation (FBA, treatment plan, progress notes, BCBA credentials).

6. REQUESTED RESOLUTION
   - Specific units / hours / CPT codes / authorization period being requested.

7. CLOSING
   - Contact information placeholders for BCBA and clinic.
   - Signature block.`;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const denialData = body?.denialData || {};
    const {
      payer,
      denialCode,
      denialReason,
      patientDiagnosis,
      requestedService,
      clinicalEvidence,
      bcbaArgument
    } = denialData;

    if (!payer || !denialCode || !denialReason) {
      return Response.json({
        error: "Payer, denial code, and denial reason are required.",
        status: "validation_error"
      }, { status: 400 });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return Response.json({
        error: "Server is missing ANTHROPIC_API_KEY.",
        detail: "Set ANTHROPIC_API_KEY in Netlify environment variables.",
        status: "config_error"
      }, { status: 500 });
    }

    const userPrompt = `
Draft a payer-ready appeal letter using the provided context.

payer: ${payer}
denial_code: ${denialCode}
denial_reason: ${denialReason}
patient_diagnosis: ${patientDiagnosis || "TO-BE-FILLED"}
requested_service: ${requestedService || "TO-BE-FILLED"}
clinical_evidence: ${clinicalEvidence || "TO-BE-FILLED"}
bcba_argument: ${bcbaArgument || "TO-BE-FILLED"}

Produce the full letter now.`;

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
          model: "claude-sonnet-4-6",
          max_tokens: 3072,
          system: buildSystemPrompt(payer),
          messages: [
            { role: "user", content: userPrompt }
          ],
        }),
      }
    );

    if (!claudeResponse.ok) {
      let errDetail = "Check API key and billing at console.anthropic.com";
      try {
        const errData = await claudeResponse.json();
        errDetail = errData.error?.message || errDetail;
      } catch {}
      console.error("Claude API error:", claudeResponse.status);
      return Response.json({
        error: `Claude API error ${claudeResponse.status}`,
        detail: errDetail,
        status: "api_error"
      }, { status: 500 });
    }

    const claudeData = await claudeResponse.json();
    const letter = claudeData.content?.[0]?.text || "";

    return Response.json({
      letter,
      status: "success",
      payer,
      denialCode,
      generatedAt: new Date().toISOString(),
      meta: {
        model: "claude-sonnet-4-6",
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

export const config = { path: "/api/generate-appeal" };
