// netlify/functions/validate-pa.js
// SECURITY: API key via process.env only — never expose to client

const VALIDATOR_SYSTEM = `You are a senior ABA billing compliance specialist.
Review PA drafts and return ONLY a valid JSON object — no markdown, no explanation.

Check for:
- CPT code validity and correct usage for ABA therapy
- Unit limits per payer (flag if exceeding 8 hours per day)
- Missing required documentation fields
- Diagnosis-to-CPT alignment (F84.0 required for ABA codes)
- Missing BCBA credentials and NPI
- Vague or non-specific medical necessity language
- Missing SMART goal format in treatment plan
- Missing modifiers (HO, 95, GT)
- Missing assessment scores (VB-MAPP, ABLLS-R, Vineland)
- Missing signature placeholders

Return this exact JSON structure — no extra text before or after:
{
  "ready": true,
  "score": 85,
  "errors": ["critical issue 1", "critical issue 2"],
  "warnings": ["minor issue 1", "minor issue 2"],
  "suggestions": ["improvement 1", "improvement 2"]
}

Score guide:
90-100: Ready to submit
80-89: Minor fixes needed
60-79: Several issues to address
0-59: Major issues — do not submit`;

export default async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    const body = await req.json();
    const { draft, payer, state } = body;

    if (!draft) {
      return Response.json({
        ready: false,
        score: 0,
        errors: ["No draft provided to validate"],
        warnings: [],
        suggestions: ["Generate a PA draft first then run validation"]
      }, { status: 400 });
    }

    const userPrompt = `Validate this ${payer || "Medicaid"} PA draft for ${state || "unknown state"}.
Return JSON only — no explanation, no markdown fences.

PA DRAFT TO VALIDATE:
${draft}`;

    const messages = [];
    messages.push({ role: "user", content: userPrompt });
    messages.push({ role: "assistant", content: "{" });

    const response = await fetch("https://api.anthropic.com/v1/messages", {
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
        messages: messages,
        stop_sequences: ["}}}"],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API ${response.status}: ${errText.slice(0, 200)}`);
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

      if (start === -1 || end === -1) throw new Error("No JSON found");

      result = JSON.parse(cleaned.slice(start, end + 1));

      if (typeof result.ready !== "boolean") result.ready = result.score >= 80;
      if (typeof result.score !== "number")  result.score = 50;
      if (!Array.isArray(result.errors))      result.errors = [];
      if (!Array.isArray(result.warnings))    result.warnings = [];
      if (!Array.isArray(result.suggestions)) result.suggestions = [];

    } catch {
      result = {
        ready: false,
        score: 50,
        errors: ["Could not parse validation response — review draft manually"],
        warnings: ["Run validation again if this error persists"],
        suggestions: ["Ensure all required fields are filled before validating"]
      };
    }

    return Response.json(result);

  } catch (err) {
    console.error("validate-pa error:", err.message);
    return Response.json({
      ready: false,
      score: 0,
      errors: ["Validation service error: " + err.message],
      warnings: [],
      suggestions: ["Check your API key and try again"]
    }, { status: 500 });
  }
};

export const config = { path: "/api/validate-pa" };