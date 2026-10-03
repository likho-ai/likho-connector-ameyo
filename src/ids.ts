/** Likho ids: a prefix and a ULID, for example rec_01JB7Z5K3M9Q2W4X6Y8A0C1E3G. They sort by creation time. */
import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const PATTERN = /^[a-z]{3}_[0-9A-HJKMNP-TV-Z]{26}$/;

function encode(value: bigint, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
}

export function newId(prefix: string): string {
  const time = encode(BigInt(Date.now()), 10);
  const random = randomBytes(10);
  let bits = 0n;
  for (const byte of random) bits = (bits << 8n) | BigInt(byte);
  return `${prefix}_${time}${encode(bits, 16)}`;
}

export function isId(value: unknown, prefix: string): value is string {
  return typeof value === 'string' && value.startsWith(prefix + '_') && PATTERN.test(value);
}
