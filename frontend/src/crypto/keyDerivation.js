const textEncoder = new TextEncoder();
const SECRET_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function randomRoomSecret(length = 6) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let secret = '';
  for (let i = 0; i < length; i++) {
    secret += SECRET_CHARS[bytes[i] % SECRET_CHARS.length];
  }
  return secret;
}

export async function deriveRoomKey(secret, roomId) {
  if (!secret || typeof secret !== 'string' || secret.trim().length < 4) {
    throw new Error('The room secret must contain at least 4 characters.');
  }

  const cleanSecret = secret.trim();
  const secretBytes = textEncoder.encode(cleanSecret);
  const hashBuffer = await crypto.subtle.digest('SHA-256', secretBytes);
  const keyMaterial = await crypto.subtle.importKey('raw', hashBuffer, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: textEncoder.encode(roomId),
      info: textEncoder.encode('SecureCode E2E message key v1'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function encodeBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

export function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Invalid base64url value.');
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
