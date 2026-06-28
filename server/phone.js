const COUNTRY_CODE = '+91';

export function normalizePhone(input) {
  if (!input || typeof input !== 'string') return null;
  const digits = input.replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    const local = digits.slice(2);
    if (local.length !== 10 || local.startsWith('0')) return null;
    return `${COUNTRY_CODE}${local}`;
  }

  if (digits.length === 10) {
    if (digits.startsWith('0')) return null;
    return `${COUNTRY_CODE}${digits}`;
  }

  if (input.trim().startsWith(COUNTRY_CODE)) {
    const local = digits.slice(-10);
    if (local.length === 10 && !local.startsWith('0')) {
      return `${COUNTRY_CODE}${local}`;
    }
  }

  return null;
}

export function validatePhone(input) {
  if (!input || !String(input).trim()) {
    return { valid: true, phone: null };
  }
  const phone = normalizePhone(input);
  if (!phone) {
    return { valid: false, error: 'Phone must be +91 followed by exactly 10 digits, not starting with 0' };
  }
  const local = phone.slice(COUNTRY_CODE.length);
  if (local.length !== 10 || local.startsWith('0')) {
    return { valid: false, error: 'Phone must be +91 followed by exactly 10 digits, not starting with 0' };
  }
  return { valid: true, phone };
}

export function formatPhoneDisplay(phone) {
  if (!phone) return '';
  const local = phone.replace(/\D/g, '').slice(-10);
  if (local.length !== 10) return phone;
  return `${COUNTRY_CODE} ${local.slice(0, 5)} ${local.slice(5)}`;
}

export { COUNTRY_CODE };
