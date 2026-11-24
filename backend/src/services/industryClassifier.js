/**
 * Industry Classifier Service (Gemini API)
 * 
 * Uses Google Gemini (temperature 0) to summarize website text into industry and business category.
 * 
 * STRICT RULES:
 * - Requires a verbatim evidence_snippet from about_text.
 * - Normalized substring check (lowercase, whitespace collapsed) strictly enforced.
 * - If check fails or about_text is empty:
 *     industry = NIC description (source "mca"), business_category = null.
 * - Gemini must NEVER produce numbers, emails, turnover, employee counts, client names
 *   or any fact not present in the input text.
 */

function normalizeForComparison(str = '') {
  return String(str || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function classifyIndustry({ nicDescription = '', aboutText = '' } = {}) {
  const cleanNic = String(nicDescription || '').trim();
  const cleanAbout = String(aboutText || '').trim();

  // If no about text, rely solely on official MCA NIC description
  if (!cleanAbout || cleanAbout.length < 25) {
    return {
      industry: cleanNic || null,
      business_category: null,
      evidence_snippet: null,
      source: cleanNic ? 'mca' : null,
      derived_by: cleanNic ? 'api' : null,
      confidence: cleanNic ? 1.0 : 0.0,
    };
  }

  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();

  if (!apiKey) {
    // LLM not configured -> fallback to MCA NIC description
    return {
      industry: cleanNic || null,
      business_category: null,
      evidence_snippet: null,
      source: cleanNic ? 'mca' : null,
      derived_by: cleanNic ? 'api' : null,
      confidence: cleanNic ? 1.0 : 0.0,
    };
  }

  const systemPrompt = `You are a strict B2B corporate taxonomy classifier.
Given the company's official MCA NIC description and official website About text, determine:
1. industry: The high-level industry sector (e.g. Rigid Plastic Packaging, Flexible Polymers, Automobile Components).
2. business_category: The specific operational category (e.g. Injection Moulding Manufacturer, BOPP Film Extrusion).
3. evidence_snippet: A verbatim sentence or phrase (10-25 words) copied EXACTLY from the provided About text supporting your choice.

STRICT REQUIREMENTS:
- evidence_snippet MUST be an exact verbatim substring from the About text. Do not rephrase or alter a single character.
- NEVER invent or generate numbers, turnover figures, headcount, client names, or emails.
- If the About text does not provide clear details, use the MCA NIC description as the industry and return null for business_category and evidence_snippet.

Return ONLY a JSON object:
{
  "industry": "string or null",
  "business_category": "string or null",
  "evidence_snippet": "string or null"
}`;

  const promptText = `OFFICIAL MCA NIC DESCRIPTION:
${cleanNic || 'Not provided'}

COMPANY WEBSITE ABOUT TEXT:
${cleanAbout.slice(0, 3000)}`;

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: promptText }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    });
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Gemini HTTP ${res.status}`);
    }

    const payload = await res.json();
    const rawText = payload?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const parsed = JSON.parse(rawText.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim());

    const proposedSnippet = String(parsed.evidence_snippet || '').trim();
    const normSnippet = normalizeForComparison(proposedSnippet);
    const normAbout = normalizeForComparison(cleanAbout);

    // Strict validation: evidence_snippet must exist verbatim in aboutText
    const isVerbatim = normSnippet.length >= 10 && normAbout.includes(normSnippet);

    if (isVerbatim && parsed.industry) {
      return {
        industry: String(parsed.industry).trim(),
        business_category: parsed.business_category ? String(parsed.business_category).trim() : null,
        evidence_snippet: proposedSnippet,
        source: 'ai_summary',
        derived_by: 'ai',
        confidence: 0.6,
      };
    }

    // Validation failed -> discard AI hallucinations, fall back strictly to MCA NIC
    return {
      industry: cleanNic || null,
      business_category: null,
      evidence_snippet: null,
      source: cleanNic ? 'mca' : null,
      derived_by: cleanNic ? 'api' : null,
      confidence: cleanNic ? 1.0 : 0.0,
    };
  } catch (err) {
    // On any network or parsing error, fallback strictly to MCA NIC
    return {
      industry: cleanNic || null,
      business_category: null,
      evidence_snippet: null,
      source: cleanNic ? 'mca' : null,
      derived_by: cleanNic ? 'api' : null,
      confidence: cleanNic ? 1.0 : 0.0,
    };
  }
}
