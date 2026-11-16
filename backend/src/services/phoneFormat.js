/**
 * Normalize phone numbers to E.164-ish +91... for Indian mobiles.
 * Leaves already-international numbers alone when possible.
 */
export function toE164India(phone) {
  if (phone == null) return null;
  const raw = String(phone).trim();
  if (!raw) return null;

  if (raw.startsWith('+')) {
    const digits = raw.slice(1).replace(/\D/g, '');
    return digits ? `+${digits}` : null;
  }

  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith('0')) return `+91${digits.slice(1)}`;

  return `+${digits}`;
}
