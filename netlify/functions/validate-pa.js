// netlify/functions/validate-pa.js
// SECURITY: API key via process.env only

// Payer-specific unit caps per week
const PAYER_CAPS = {
  "medicaid": { unitsPerWeekCap: 40, hoursPerDayCap: 8 },
  "uhc":      { unitsPerWeekCap: 40, hoursPerDayCap: 8 },
  "anthem":   { unitsPerWeekCap: 40, hoursPerDayCap: 8 },
  "bcbs":     { unitsPerWeekCap: 40, hoursPerDayCap: 8 },
  "aetna":    { unitsPerWeekCap: 32, hoursPerDayCap: 8 },
  "cigna":    { unitsPerWeekCap: 40, hoursPerDayCap: 8 },
  "molina":   { unitsPerWeekCap: 40, hoursPerDayCap: 8 },
};

function scoreToRiskLabel(score) {
  if (score >= 80) return "Low";
  if (score >= 50) return "Medium";
  return "High";
}

const VALIDATOR_SYSTEM = `You are a senior ABA billing compliance
specialist. Review PA drafts and return ONLY valid JSON.
No markdown. No explanation. Just the JSON.

Check for:
- CPT code validity for ABA therapy (97153-97158)
- Unit limits per payer — flag if exceeding 8 hours per day
- Diagnosis-to-CPT alignment (F84.x required for ABA codes)
- Missing BCBA credentials and NPI
- Wrong or missing modifiers (HO, 95, GT, HN)
- Vague medical necessity — missing functional-status language
- Missing SMART goals in treatment plan
- Missing assessment scores (VB-MAPP, ABLLS-R, Vineland)
- Missing family-training narrative for 97156/97157
- Missing signature placeholders for BCBA and physician

Return exactly this JSON — no extra text:
{
  "ready": true or false,
  "score": 0-100,
  "denialRiskLabel": "Low" or "Medium" or "High",
  "errors": ["critical issue 1"],
  "warnings": ["minor issue 1"],
  "suggestions": ["improvement 1"]
}`;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const { draft, payer, state, hoursPerWeek } = body;

    if (!draft) {
      return Response.json({
        ready: false, score: 0,
        denialRiskLabel: "High",
        errors: ["No draft provided to validate"],
        warnings: [], suggestions: []
      }, { status: 400 });
    }

    // Pre-score based on payer rules before sending to Claude
    let preScore = 100;
    const preWarnings = [];
    const payerKey = (payer || "medicaid").toLowerCase();
    const caps = PAYER_CAPS[payerKey] || PAYER_CAPS["medicaid"];

    if (hoursPerWeek) {
      const units = parseInt(hoursPerWeek) * 4;
      if (units > caps.unitsPerWeekCap) {
        preScore -= 25;
        preWarnings.push(
          "Hours per week (" + hoursPerWeek +
          " hrs = " + units + " units) exceeds payer cap of " +
          caps.unitsPerWeekCap + " units for " + payerKey.toUpperCase()
        );
      }
    }

    const userPrompt =
      "Validate this " + (payer || "Medicaid") +
      " PA draft for " + (state || "unknown state") +
      ". Return JSON only:\n\n" + draft;

    const messages = [
      { role: "user", content: userPrompt },
      { role: "assistant", content: "{" }
    ];

    const response = await fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          max_tokens: 1024,
          system: VALIDATOR_SYSTEM,
          messages,
          stop_sequences: ["}}}"],
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error("Claude API " + response.status +
        ": " + errText.slice(0, 200));
    }

    const data = await response.json();
    const rawText = "{" + (data?.content?.[0]?.text || "").trim();

    let result;
    try {
      const cleaned = rawText
        .replace(/```json\s*/gi, "")
        .replace(/```\s*/gi, "")
        .trim();
      const start = cleaned.indexOf("{");
      const end   = cleaned.lastIndexOf("}");
      if (start === -1 || end === -1) throw new Error("No JSON");
      result = JSON.parse(cleaned.slice(start, end + 1));

      // Merge pre-score warnings
      if (preWarnings.length > 0) {
        result.warnings = [...preWarnings, ...(result.warnings || [])];
        result.score = Math.max(0, (result.score || 100) - 25);
      }

      // Enforce types
      if (typeof result.ready !== "boolean")
        result.ready = result.score >= 80;
      if (typeof result.score !== "number") result.score = 50;
      if (!Array.isArray(result.errors))    result.errors = [];
      if (!Array.isArray(result.warnings))  result.warnings = [];
      if (!Array.isArray(result.suggestions))
        result.suggestions = [];

      // Add denial-risk label
      result.denialRiskLabel = scoreToRiskLabel(result.score);

    } catch {
      result = {
        ready: false, score: 50,
        denialRiskLabel: "Medium",
        errors: ["Could not parse validation — review manually"],
        warnings: preWarnings,
        suggestions: ["Ensure all required fields are filled"]
      };
    }

    return Response.json(result);

  } catch (err) {
    console.error("validate-pa error:", err.message);
    return Response.json({
      ready: false, score: 0,
      denialRiskLabel: "High",
      errors: ["Validation error: " + err.message],
      warnings: [], suggestions: []
    }, { status: 500 });
  }
};

export const config = { path: "/api/validate-pa" };