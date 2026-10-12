import { describe, expect, it } from 'vitest';
import { isValidSignature, safeEqual, signBody } from './signature.js';

const secret = 'app-secret-0123456789';
const body = new TextEncoder().encode('{"a":1}');

describe('isValidSignature', () => {
  it('accepts the correct HMAC-SHA256 of the raw bytes', () => {
    expect(isValidSignature(body, signBody(body, secret), secret)).toBe(true);
  });

  it('accepts uppercase hex', () => {
    expect(isValidSignature(body, signBody(body, secret).replace(/[a-f]/g, (c) => c.toUpperCase()).replace('SHA256', 'sha256'), secret)).toBe(
      true,
    );
  });

  it.each([
    ['null header', null],
    ['empty', ''],
    ['no prefix', signBody(body, secret).slice(7)],
    ['short digest', 'sha256=abcd'],
    ['other secret', signBody(body, 'different-secret-xyz')],
  ])('rejects %s', (_l, header) => {
    expect(isValidSignature(body, header, secret)).toBe(false);
  });

  it('rejects when the secret is empty', () => {
    expect(isValidSignature(body, signBody(body, ''), '')).toBe(false);
  });

  it('matches an independently computed HMAC (openssl)', () => {
    // printf '%s' '{"a":1}' | openssl dgst -sha256 -hmac app-secret-0123456789
    expect(signBody('{"a":1}', secret)).toBe('sha256=dab40868c03ca7eb6d1dd132d5487d8fa84396a3941484b22ab2bb974d72d788');
  });
});

describe('safeEqual', () => {
  it('compares strings of different lengths safely', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});
