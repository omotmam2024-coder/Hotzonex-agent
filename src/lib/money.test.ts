import { describe, expect, it } from 'vitest';
import { currencyDigits, formatMoney, minorToInput, parseMoneyInput } from './money';

describe('money', () => {
  it('knows minor-unit digits per currency', () => {
    expect(currencyDigits('USD')).toBe(2);
    expect(currencyDigits('UGX')).toBe(0);
    expect(currencyDigits('JPY')).toBe(0);
  });

  it.each([
    ['12.50', 'USD', 1250],
    ['12.5', 'USD', 1250],
    ['0.07', 'USD', 7],
    ['1,000', 'USD', 100000],
    ['5000', 'UGX', 5000],
  ])('parses %s %s', (input, currency, expected) => {
    expect(parseMoneyInput(input, currency)).toBe(expected);
  });

  it.each([['12.345', 'USD'], ['-1', 'USD'], ['abc', 'USD'], ['', 'USD'], ['50.5', 'UGX'], ['1e3', 'USD']])(
    'rejects %s %s',
    (input, currency) => {
      expect(parseMoneyInput(input, currency)).toBeNull();
    },
  );

  it('formats and round-trips', () => {
    expect(formatMoney(1250, 'USD', 'en-US')).toBe('$12.50');
    expect(minorToInput(1250, 'USD')).toBe('12.50');
    expect(minorToInput(5000, 'UGX')).toBe('5000');
  });
});
