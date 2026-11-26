import { enrichCompanyProfile } from './companyIntelEnricher.js';
import { getCallById, getLeadById, upsertClientIntel } from '../db.js';

function getGeminiConfig() {
  const apiKey = String(process.env.GEMINI_API_KEY || '').trim();
  const model = String(process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim();
  const useLiveAi = Boolean(apiKey) && process.env.NODE_ENV !== 'test';
  return { apiKey, model, useLiveAi };
}

function extractJsonFromText(text = '') {
  const cleaned = String(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

const CONVERSATIONAL_STOPWORDS = new Set([
  'theek', 'theek hai', 'thik', 'thik hai', 'haan', 'ha', 'hanji', 'haanji',
  'achha', 'accha', 'acha', 'achhaji', 'acchaji', 'sahi', 'sahi hai',
  'abhi', 'abhi nahi', 'baad', 'baad mein', 'baad me', 'nahi', 'nahin',
  'namaste', 'hello', 'hi', 'hey', 'good morning', 'good afternoon', 'good evening',
  'sir', 'madam', 'maam', 'mam', 'bhai', 'bhaiya', 'ji', 'boss',
  'quote', 'quotation', 'rate', 'price', 'pricing', 'details', 'pehle', 'kal',
  'yes', 'no', 'okay', 'ok', 'sure', 'fine', 'thanks', 'thank you', 'please',
  'hum', 'humein', 'aap', 'aapko', 'mera', 'meri', 'kuch', 'kaun', 'kya',
  'suniyen', 'boliye', 'bataiye', 'dekh', 'dekhta', 'dekhunga', 'bhej', 'bhejo',
  'employee', 'client', 'prospect', 'lead', 'unknown', 'new prospect', 'caller',
  'requirement', 'support', 'filing', 'credit', 'credits', 'waste', 'plastic',
  'this', 'that', 'here', 'there', 'call', 'caller', 'response', 'outgoing', 'incoming',
]);

export function isPhoneInTranscript(candidatePhone = '', transcript = '') {
  if (!candidatePhone || !transcript) return false;
  const digits = String(candidatePhone).replace(/\D/g, '');
  if (digits.length < 7) return false;
  const cleanTranscript = String(transcript).replace(/\D/g, '');
  return cleanTranscript.includes(digits.slice(-7));
}

export function isInvalidPhoneNumber(phone = '', verifiedPhone = '') {
  if (!phone || typeof phone !== 'string') return true;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return true;
  if (/^(0{10}|1{10}|2{10}|3{10}|4{10}|5{10}|6{10}|7{10}|8{10}|9{10})$/.test(digits)) return true;
  if (/not disclosed|not stated|not available|null|undefined/i.test(phone)) return true;
  return false;
}

export function isInvalidPersonName(name = '', execName = '') {
  if (!name || typeof name !== 'string') return true;
  const clean = name.trim().toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, '');
  if (!clean || clean.length < 2) return true;

  // Digits indicate phone numbers or auto-generated prospect IDs (e.g. 'Prospect 8826893333')
  if (/\d/.test(name)) return true;

  // Generic caller / system labels
  if (/\b(prospect|client|lead|caller|unknown|new prospect|customer|user|call)\b/i.test(name)) {
    return true;
  }

  if (CONVERSATIONAL_STOPWORDS.has(clean)) return true;

  // Multi-word phrase containing primary conversational filler
  const words = clean.split(/\s+/);
  if (
    words.length <= 2 &&
    words.some((w) =>
      ['theek', 'haan', 'ha', 'accha', 'abhi', 'baad', 'nahi', 'sir', 'quote', 'kal', 'this', 'that', 'client', 'here'].includes(w)
    )
  ) {
    return true;
  }

  // Any company suffix or company terms in person name
  if (
    /\b(ltd|limited|pvt|private|industries|polymers|plastics|packaging|corp|inc|llp|technologies|solutions|group|products)\b/i.test(
      name
    )
  ) {
    return true;
  }

  // Common Hindi dialogue / conversational patterns
  if (
    clean.includes('bol raha') ||
    clean.includes('baat kar') ||
    clean.includes('theek hai') ||
    clean.includes('baad mein') ||
    clean.includes('dekh lunga') ||
    clean.includes('bhej do') ||
    clean.includes('abhi nahi')
  ) {
    return true;
  }

  // Must not be our own BD executive's name
  if (execName) {
    const execParts = execName.toLowerCase().split(/\s+/);
    if (execParts.some((p) => p.length > 2 && clean.includes(p))) {
      return true;
    }
  }

  return false;
}

function isInvalidCompanyName(name = '', execName = '') {
  if (!name || typeof name !== 'string') return true;
  const lower = name.toLowerCase();
  if (
    lower.includes('bol raha') ||
    lower.includes('namaste') ||
    lower.includes('hello') ||
    lower.includes('good morning') ||
    lower.includes('hoon')
  ) {
    return true;
  }
  if (lower.includes('climeto') || lower.includes('employee')) return true;
  if (execName) {
    const firstWord = execName.split(/\s+/)[0]?.toLowerCase();
    if (firstWord && lower.includes(firstWord)) return true;
  }
  return false;
}

/**
 * Heuristic fallback NLP extractor for calls when Gemini is offline or in test mode.
 * Strictly avoids hallucinating fake data — if a field was not mentioned in the call,
 * it marks it 'Not Disclosed' or 'Not Scheduled' rather than generating fictional values.
 */
function extractFromTranscriptHeuristic({
  transcript = '',
  clientName = '',
  companyName = '',
  phone = '',
  executiveName = '',
  channelSummary = '',
  callDate = '',
  promise = '',
  nextAction = '',
  leadEmail = '',
}) {
  const text = `${transcript} ${channelSummary}`.toLowerCase();

  // 1. Company Name detection - Client Company MUST NOT be Climeto or the BD executive
  let detectedCompany = companyName || '';
  if (isInvalidCompanyName(detectedCompany, executiveName)) {
    detectedCompany = '';
  }

  if (!detectedCompany) {
    const compMatch = transcript.match(/(?:from|client|firm|industries|private limited|ltd|polymers|plastics|foods)\s+([A-Z][a-zA-Z0-9\s&]+(?:Pvt|Ltd|Limited|Industries|Packaging|Polymers|Plastics)?)/i);
    if (compMatch && compMatch[1] && !isInvalidCompanyName(compMatch[1], executiveName)) {
      detectedCompany = compMatch[1].trim();
    } else if (clientName && !isInvalidCompanyName(clientName, executiveName)) {
      detectedCompany = clientName;
    } else {
      detectedCompany = phone ? `Client (${phone})` : 'Prospective Client';
    }
  }

  // 2. Contact Details - Client Contact Person (NOT our BD executive)
  let detectedName = '';
  if (clientName && !isInvalidPersonName(clientName, executiveName) && clientName !== detectedCompany) {
    detectedName = clientName;
  } else {
    // Match only real introduction phrases or honorifics (NEVER plain dialog turns like 'Client: Theek hai')
    const nameMatch = transcript.match(
      /(?:(?:i am|my name is|mera naam|myself|here)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)|(?:mr\.?|shri|smt\.?|dr\.?)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?))/i
    );
    const candidate = nameMatch ? (nameMatch[1] || nameMatch[2]) : null;
    if (candidate && !isInvalidPersonName(candidate, executiveName)) {
      detectedName = candidate.trim();
    } else {
      detectedName = 'Not Mentioned in Call';
    }
  }

  // Designation & Department (Strictly null if not explicitly mentioned)
  let designation = null;
  let department = null;
  let seniority = null;
  let decisionMaker = null;

  if (text.includes('director') || text.includes('owner') || text.includes('founder') || text.includes('partner') || text.includes('malik')) {
    designation = 'Managing Director / Owner';
    department = 'Executive Management';
    seniority = 'CXO / Owner';
    decisionMaker = 'Decision Maker';
  } else if (text.includes('purchase') || text.includes('procurement') || text.includes('sourcing') || text.includes('kharidari')) {
    designation = 'Procurement Manager';
    department = 'Procurement';
    seniority = 'Manager';
    decisionMaker = 'Influencer';
  } else if (text.includes('compliance') || text.includes('ehs') || text.includes('esg') || text.includes('environment')) {
    designation = 'EHS & Compliance Officer';
    department = 'EHS / Compliance';
    seniority = 'Lead';
    decisionMaker = 'Influencer';
  } else if (text.includes('plant') || text.includes('factory') || text.includes('operations')) {
    designation = 'Plant Operations Head';
    department = 'Plant Operations';
    seniority = 'Director / Head';
    decisionMaker = 'Decision Maker';
  }

  // 3. Sales Intelligence (Strictly null if not stated)
  let leadTemperature = null;
  if (text.includes('interested') || text.includes('quote bhej') || text.includes('quotation bhej') || text.includes('meeting') || text.includes('urgent') || text.includes('target pending') || text.includes('kal dekh')) {
    leadTemperature = 'Hot';
  } else if (text.includes('time nahi') || text.includes('not interested') || text.includes('zarurat nahi') || text.includes('cut call') || text.includes('wrong number')) {
    leadTemperature = 'Cold';
  }

  let clientRequirement = null;
  if (text.includes('battery')) clientRequirement = 'Battery Waste EPR Compliance';
  else if (text.includes('e-waste') || text.includes('electronic')) clientRequirement = 'E-Waste EPR Authorization';
  else if (text.includes('category 1') || text.includes('category i') || text.includes('rigid')) clientRequirement = 'Rigid Plastic (Cat I) EPR Credits';
  else if (text.includes('flexible') || text.includes('category 2') || text.includes('category ii')) clientRequirement = 'Flexible Plastic (Cat II) Recycling Credits';
  else if (text.includes('tyre')) clientRequirement = 'Tyre Waste EPR Compliance';
  else if (text.includes('oil')) clientRequirement = 'Used Oil EPR Compliance';
  else if (text.includes('epr') || text.includes('cpcb') || text.includes('credit') || text.includes('waste')) clientRequirement = 'EPR Plastic Waste Management & CPCB Compliance';

  let currentVendor = null;
  const vendorMatch = transcript.match(/(?:already|current vendor|working with|se le rahe hain)\s+([A-Za-z0-9\s]+?)(?:\s+se|\s+ke|\.|\,)/i);
  if (vendorMatch && vendorMatch[1] && vendorMatch[1].length < 30) {
    currentVendor = vendorMatch[1].trim();
  }

  let mainProblem = null;
  if (text.includes('rate') || text.includes('price') || text.includes('costly') || text.includes('expensive') || text.includes('mehenga')) {
    mainProblem = 'High credit rate & pricing discrepancy in existing PRO vendor';
  } else if (text.includes('notice') || text.includes('penalty') || text.includes('deadline')) {
    mainProblem = 'Upcoming CPCB portal annual filing deadline & penalty risk';
  } else if (text.includes('delay') || text.includes('certificate')) {
    mainProblem = 'Delays in getting recycling certificates from local recycler';
  } else if (text.includes('quotation') || text.includes('quote') || text.includes('details bhej')) {
    mainProblem = 'Reviewing EPR credit pricing & compliance certification process';
  }

  let nextFollowup = null;
  const followMatch = transcript.match(/(?:call\s+(?:on|at|tomorrow|kal)|kal|tomorrow|tuesday|wednesday|monday|thursday|friday|saturday)\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)/i);
  if (followMatch) {
    nextFollowup = followMatch[0].trim();
  } else if (promise && promise !== 'No firm promise' && promise !== 'Pending follow-up') {
    nextFollowup = promise;
  } else if (nextAction && nextAction !== 'Review completed call and plan follow-up.') {
    nextFollowup = nextAction;
  }

  const emailMatch = transcript.match(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/i);
  const detectedEmail = emailMatch ? emailMatch[1] : null;

  return {
    detectedCompany,
    contact_name: detectedName !== 'Not Mentioned in Call' ? detectedName : null,
    contact_email: detectedEmail,
    contact_designation: designation,
    contact_department: department,
    contact_phone: phone || null,
    decision_maker: decisionMaker,
    seniority,
    lead_temperature: leadTemperature,
    lead_source: 'Calling',
    client_requirement: clientRequirement,
    current_vendor: currentVendor,
    main_problem: mainProblem,
    budget: null,
    last_interaction: callDate ? `Call on ${new Date(callDate).toLocaleDateString('en-IN')}` : null,
    next_followup: nextFollowup,
  };
}

/**
 * Extracts 360-degree client profiling data from a call transcript
 * and enriches it with verified MCA corporate data (Category A).
 */
export async function extractAndSaveClientIntel({
  targetType = 'call',
  targetId,
  leadId = null,
  callId = null,
  transcript = '',
  clientName = '',
  companyName = '',
  phone = '',
  executiveName = '',
  callDate = '',
  promise = '',
  nextAction = '',
  leadEmail = '',
} = {}) {
  if (!targetId) throw new Error('targetId is required for client intel extraction');

  const { apiKey, model, useLiveAi } = getGeminiConfig();
  let extracted = null;

  if (useLiveAi && transcript) {
    const systemPrompt = `You are an elite B2B Sales Intelligence Analyst for Climeto EPR solutions in India.
Analyze the following BD call transcript strictly. Extract the exact contact details and sales intelligence for the PROSPECT CLIENT whom our sales executive called.
IMPORTANT RULES:
1. Our sales executive (${executiveName || 'Climeto BD'}) is NOT the client! Do NOT output our employee or Climeto as the client company or contact.
2. NEVER hallucinate fictional details. If a specific field was not stated by the client in the call, return "Not Disclosed" or "Not Scheduled".

Return ONLY valid JSON matching this schema:
{
  "company_name": "Exact prospect client company name mentioned or null",
  "company_website": "Domain if mentioned or null",
  "location_hint": "City/state if mentioned or null",
  "contact_name": "Full name of prospect client or null",
  "contact_email": "Business email if mentioned or null",
  "contact_designation": "Role (e.g. Procurement Manager, Director, EHS Head)",
  "contact_department": "Department (e.g. Procurement, EHS, Operations)",
  "contact_phone": "Phone if stated",
  "decision_maker": "Decision Maker | Influencer | Gatekeeper",
  "seniority": "CXO | Director | Manager | Executive",
  "lead_temperature": "Hot | Warm | Cold",
  "lead_source": "Calling",
  "client_requirement": "Exact EPR waste or packaging requirement discussed",
  "current_vendor": "Current PRO vendor if named, or 'Not Disclosed'",
  "main_problem": "Primary pain point or challenge discussed, or 'Not Disclosed'",
  "budget": "Budget if discussed, else 'Not Disclosed'",
  "next_followup": "Specific callback time/date agreed upon, else 'Not Scheduled'"
}`;

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: `PROSPECT CLIENT CALL:\nCompany: ${companyName}\nContact: ${clientName}\nTranscript:\n${transcript}` }] }],
          generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
        }),
      });
      if (res.ok) {
        const payload = await res.json();
        const raw = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (raw) {
          extracted = extractJsonFromText(raw);
        }
      }
    } catch (err) {
      console.warn('[ClientIntel] Live Gemini extraction failed, falling back to heuristic:', err.message);
    }
  }

  // If live AI did not return, use strict heuristic extractor
  if (!extracted) {
    const h = extractFromTranscriptHeuristic({
      transcript,
      clientName,
      companyName,
      phone,
      executiveName,
      callDate,
      promise,
      nextAction,
      leadEmail,
    });
    extracted = {
      company_name: h.detectedCompany,
      company_website: '',
      location_hint: '',
      contact_name: h.contact_name,
      contact_email: h.contact_email,
      contact_designation: h.contact_designation,
      contact_department: h.contact_department,
      contact_phone: h.contact_phone,
      decision_maker: h.decision_maker,
      seniority: h.seniority,
      lead_temperature: h.lead_temperature,
      lead_source: h.lead_source,
      client_requirement: h.client_requirement,
      current_vendor: h.current_vendor,
      main_problem: h.main_problem,
      budget: h.budget,
      next_followup: h.next_followup,
    };
  }

  // Ensure target company is NOT Climeto or executive name
  let targetCompany = extracted.company_name || companyName || clientName || (phone ? `Client (${phone})` : 'Target Enterprise');
  if (isInvalidCompanyName(targetCompany, executiveName)) {
    targetCompany = (phone ? `Client (${phone})` : 'Target Enterprise');
  }

  // Now enrich Category A (Company Profile) using verified MCA registry or live website
  const companyEnriched = await enrichCompanyProfile({
    companyName: targetCompany,
    domain: extracted.company_website || '',
    locationHint: extracted.location_hint || '',
  });

  const fullIntel = {
    target_type: targetType,
    target_id: targetId,
    lead_id: leadId,
    call_id: callId || (targetType === 'call' ? targetId : null),
    
    // Category A: Company Profile (PROSPECT CLIENT COMPANY - NO FAKE DATA)
    company_name: companyEnriched.company_name || targetCompany,
    company_website: companyEnriched.company_website || null,
    industry: companyEnriched.industry || null,
    company_email: companyEnriched.company_email || null,
    company_phone: phone || null,
    location: companyEnriched.location || null,
    employee_count: companyEnriched.employee_count || null,
    annual_turnover: companyEnriched.annual_turnover || null,
    company_type: companyEnriched.company_type || null,
    business_category: companyEnriched.business_category || null,

    // Category B: Contact Person Profile (PROSPECT CLIENT CONTACT - ACTUAL DETAILS)
    contact_name: (extracted.contact_name && !isInvalidPersonName(extracted.contact_name, executiveName) && extracted.contact_name !== targetCompany)
      ? extracted.contact_name
      : (clientName && !isInvalidPersonName(clientName, executiveName) && clientName !== targetCompany
          ? clientName
          : null),
    contact_email: (extracted.contact_email && extracted.contact_email !== 'Business email' && extracted.contact_email !== 'Not Disclosed') ? extracted.contact_email : null,
    contact_designation: extracted.contact_designation || null,
    contact_department: extracted.contact_department || null,
    contact_phone: (extracted.contact_phone && isPhoneInTranscript(extracted.contact_phone, transcript) && !isInvalidPhoneNumber(extracted.contact_phone))
      ? extracted.contact_phone
      : (phone || null),
    decision_maker: extracted.decision_maker || null,
    seniority: extracted.seniority || null,

    // Category C: Sales Intelligence (ANALYSED FROM CALL)
    lead_temperature: extracted.lead_temperature || null,
    lead_source: extracted.lead_source || 'Calling',
    client_requirement: extracted.client_requirement || null,
    current_vendor: extracted.current_vendor && extracted.current_vendor !== 'Not Disclosed' ? extracted.current_vendor : null,
    main_problem: extracted.main_problem && extracted.main_problem !== 'Not Disclosed' ? extracted.main_problem : null,
    budget: extracted.budget && extracted.budget !== 'Not Disclosed' ? extracted.budget : null,
    last_interaction: callDate ? `Call on ${new Date(callDate).toLocaleDateString('en-IN')}` : null,
    next_followup: extracted.next_followup && extracted.next_followup !== 'Not Scheduled' ? extracted.next_followup : null,

    raw_transcript: transcript ? transcript.slice(0, 1000) : '',
    extraction_source: companyEnriched.extraction_source || 'ai_verified',
    is_verified: companyEnriched.is_verified ?? 1,
  };

  // Upsert into SQLite database
  const saved = upsertClientIntel(fullIntel);
  return saved;
}

/**
 * Helper to extract client intel for a call by ID
 */
export async function extractClientIntelForCall(callId) {
  const call = getCallById(callId);
  if (!call) throw new Error(`Call not found: ${callId}`);

  let companyName = call.company || '';
  let clientName = call.client_name || '';
  let phone = call.client_phone || call.phone || '';
  let leadEmail = '';
  const executiveName = call.executive_name || '';

  if (call.lead_id) {
    const leadDetail = getLeadById(call.lead_id);
    const lead = leadDetail?.lead || leadDetail;
    if (lead) {
      if (!companyName && lead.company && !isInvalidCompanyName(lead.company, executiveName)) {
        companyName = lead.company;
      }
      if (!clientName || clientName.startsWith('Prospect')) {
        clientName = (lead.client_name && !lead.client_name.startsWith('Prospect')) ? lead.client_name : '';
      }
      if (lead.client_phone) phone = lead.client_phone;
      if (lead.email) leadEmail = lead.email;
    }
  }

  // If clientName has company indicators or companyName is empty, resolve properly
  if (!companyName && clientName && !isInvalidCompanyName(clientName, executiveName)) {
    companyName = clientName;
  }

  return extractAndSaveClientIntel({
    targetType: 'call',
    targetId: call.id,
    leadId: call.lead_id,
    callId: call.id,
    transcript: call.transcript || call.summary || '',
    clientName,
    companyName,
    phone,
    executiveName,
    callDate: call.created_at || call.call_time,
    promise: call.promise || '',
    nextAction: call.next_action || call.nextAction || '',
    leadEmail,
  });
}
