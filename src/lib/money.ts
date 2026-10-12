/** Number of minor-unit digits for a currency (2 for USD, 0 for UGX/JPY). */
export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

export function formatMoney(minor: number, currency: string, locale?: string): string {
  const digits = currencyDigits(currency);
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(minor / 10 ** digits);
  } catch {
    return `${(minor / 10 ** digits).toFixed(digits)} ${currency}`;
  }
}

/**
 * Parses a user-typed amount ("12.50") into integer minor units without
 * floating-point rounding. Returns null when invalid.
 */
export function parseMoneyInput(value: string, currency: string): number | null {
  const digits = currencyDigits(currency);
  const v = value.trim().replace(/,/g, '');
  const pattern = digits === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{0,${digits}})?$`);
  if (!pattern.test(v)) return null;
  const [whole = '0', frac = ''] = v.split('.');
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

export function minorToInput(minor: number, currency: string): string {
  const digits = currencyDigits(currency);
  return digits === 0 ? String(minor) : (minor / 10 ** digits).toFixed(digits);
}
