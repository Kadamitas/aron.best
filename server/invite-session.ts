import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const cookieName = 'workshop_access';
const lifetime = 30 * 24 * 60 * 60;

function signature(value: string, secret: string): string { return createHmac('sha256', secret).update(value).digest('base64url'); }

export function inviteCookie(secret: string, secure: boolean): string {
  const value = `${Math.floor(Date.now() / 1000) + lifetime}.${randomBytes(24).toString('base64url')}`;
  return `${cookieName}=${value}.${signature(value, secret)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${lifetime}${secure ? '; Secure' : ''}`;
}

export function validInviteCookie(cookie: string | undefined, secret: string): boolean {
  if (secret.length < 32 || !cookie || cookie.length > 8192) return false;
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  if (!token || token.length > 200) return false;
  const [expiry, nonce, signed, ...rest] = token.split('.');
  if (!expiry || !nonce || !signed || rest.length || !/^\d{10}$/.test(expiry) || !/^[A-Za-z0-9_-]{32}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(signed)) return false;
  const remaining = Number(expiry) - Date.now() / 1000;
  if (remaining <= 0 || remaining > lifetime) return false;
  const expected = signature(`${expiry}.${nonce}`, secret);
  return signed.length === expected.length && timingSafeEqual(Buffer.from(signed), Buffer.from(expected));
}
