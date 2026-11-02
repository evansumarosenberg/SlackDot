import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const equal = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
async function key(encoded: string) {
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length !== 32) throw new Error('invalid_encryption_key');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encrypt(secret: string, encoded: string, id: string) {
  const iv = randomBytes(12);
  const result = await crypto.subtle.encrypt({name:'AES-GCM', iv, additionalData: Buffer.from(id)}, await key(encoded), Buffer.from(secret));
  return `v1.${iv.toString('base64')}.${Buffer.from(result).toString('base64')}`;
}
export async function decrypt(value: string, encoded: string, id: string) {
  const [version, iv, ciphertext] = value.split('.');
  if (version !== 'v1') throw new Error('invalid_ciphertext');
  const result = await crypto.subtle.decrypt({name:'AES-GCM', iv:Buffer.from(iv,'base64'), additionalData:Buffer.from(id)}, await key(encoded), Buffer.from(ciphertext,'base64'));
  return Buffer.from(result).toString('utf8');
}
