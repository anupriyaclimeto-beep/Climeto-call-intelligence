/**
 * Official Website Scraper Service
 * 
 * Extracts verified business contact information and "About Us" text
 * strictly from the company's official public website.
 * 
 * STRICT RULES:
 * - Returns HTTP 200 AND page must mention company name or CIN; otherwise website = null.
 * - Respects robots.txt.
 * - Extracts business email/phone ONLY if literally written on the page. Never synthetically builds info@<domain>.
 * - Limits about_text to max 3000 characters.
 */

function cleanText(str = '') {
  return str
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Basic robots.txt parser for specific user-agent
 */
async function isPathAllowedByRobots(baseUrl, path) {
  try {
    const robotsUrl = new URL('/robots.txt', baseUrl).href;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);

    const res = await fetch(robotsUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'ClimetoCorporateBot/1.0' },
    });
    clearTimeout(timer);

    if (!res.ok) return true; // No robots.txt or 404 means allowed

    const text = await res.text();
    const lines = text.split('\n').map((l) => l.trim());
    let appliesToUs = true;

    for (const line of lines) {
      if (line.toLowerCase().startsWith('user-agent:')) {
        const agent = line.split(':')[1]?.trim() || '';
        appliesToUs = agent === '*' || agent.toLowerCase().includes('climeto');
      } else if (appliesToUs && line.toLowerCase().startsWith('disallow:')) {
        const disallowPath = line.split(':')[1]?.trim() || '';
        if (disallowPath && path.startsWith(disallowPath)) {
          return false;
        }
      }
    }
    return true;
  } catch {
    return true; // network error on robots.txt -> permit standard fetch
  }
}

/**
 * Extract literal emails only
 */
function extractLiteralEmails(html = '', text = '') {
  const combined = `${html} ${text}`;
  const ignoredPatterns = ['example.com', 'w3.org', 'schema.org', 'domain.com', 'sentry.io', '.png', '.jpg', '.jpeg', '.svg', '.webp'];

  const mailtoMatches = Array.from(combined.matchAll(/mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi)).map(m => m[1]);
  const textMatches = Array.from(combined.matchAll(/\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/gi)).map(m => m[1]);

  const candidates = [...mailtoMatches, ...textMatches];
  for (const c of candidates) {
    const lower = c.toLowerCase();
    if (ignoredPatterns.some((bad) => lower.includes(bad))) continue;
    return lower;
  }
  return null;
}

/**
 * Extract literal phone numbers only (Indian mobile/landline with area code)
 */
function extractLiteralPhones(text = '') {
  const phoneRegex = /(?:\+91[\-\s]?)?[6-9]\d{4}[\-\s]?\d{5}|0\d{2,4}[\-\s]?\d{6,8}/g;
  const matches = text.match(phoneRegex);
  if (matches && matches.length > 0) {
    const cleaned = matches[0].replace(/\s+/g, ' ').trim();
    if (cleaned.length >= 8 && cleaned.length <= 16) {
      return cleaned;
    }
  }
  return null;
}

/**
 * Fetch a single page safely
 */
async function fetchPage(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ClimetoIntelligence/1.0',
        Accept: 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const html = await res.text();
    return { html, url: res.url || url };
  } catch {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Main scraper entry point
 */
export async function scrapeOfficialWebsite({ domain = '', companyName = '', cin = '' } = {}) {
  let targetUrl = domain ? (domain.startsWith('http') ? domain : `https://${domain}`) : '';
  if (!targetUrl) {
    return { website: null, email: null, phone: null, about_text: null, source_urls: [] };
  }

  // Parse hostname
  let origin = '';
  try {
    const parsed = new URL(targetUrl);
    origin = parsed.origin;
    targetUrl = origin;
  } catch {
    return { website: null, email: null, phone: null, about_text: null, source_urls: [] };
  }

  // Check robots.txt for home page
  const homeAllowed = await isPathAllowedByRobots(origin, '/');
  if (!homeAllowed) {
    return { website: null, email: null, phone: null, about_text: null, source_urls: [] };
  }

  // Fetch Home page
  const homeResult = await fetchPage(targetUrl);
  if (!homeResult) {
    return { website: null, email: null, phone: null, about_text: null, source_urls: [] };
  }

  const homeText = cleanText(homeResult.html);

  // Verification check: Page must return HTTP 200 AND mention company name or CIN
  const normText = homeText.toLowerCase();
  const normName = String(companyName || '').toLowerCase().replace(/\b(pvt|ltd|limited|private)\b/g, '').trim();
  const normCin = String(cin || '').toLowerCase().trim();

  const nameMatch = normName.length >= 3 && normText.includes(normName);
  const cinMatch = normCin.length >= 6 && normText.includes(normCin);

  if (!nameMatch && !cinMatch) {
    // Official domain verification failed (domain doesn't mention the corporate entity)
    return { website: null, email: null, phone: null, about_text: null, source_urls: [] };
  }

  const sourceUrls = [homeResult.url];
  let email = extractLiteralEmails(homeResult.html, homeText);
  let phone = extractLiteralPhones(homeText);
  let aboutTextAccumulator = homeText.slice(0, 1500);

  // If email or phone or about is brief, try /about or /contact
  const extraPages = ['/about', '/about-us', '/contact', '/contact-us'];
  for (const pagePath of extraPages) {
    if (email && phone && aboutTextAccumulator.length > 2000) break;

    const allowed = await isPathAllowedByRobots(origin, pagePath);
    if (!allowed) continue;

    const pageUrl = `${origin}${pagePath}`;
    const pageResult = await fetchPage(pageUrl, 5000);
    if (!pageResult) continue;

    sourceUrls.push(pageResult.url);
    const pageText = cleanText(pageResult.html);

    if (!email) {
      email = extractLiteralEmails(pageResult.html, pageText);
    }
    if (!phone) {
      phone = extractLiteralPhones(pageText);
    }

    if (pagePath.includes('about')) {
      aboutTextAccumulator = `${aboutTextAccumulator}\n${pageText}`.slice(0, 3000);
    }
  }

  return {
    website: origin,
    email: email || null,
    phone: phone || null,
    about_text: aboutTextAccumulator.slice(0, 3000) || null,
    source_urls: Array.from(new Set(sourceUrls)),
  };
}
