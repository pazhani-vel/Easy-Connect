const textEncoder = new TextEncoder();

export function randomRoomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return encodeBase64Url(bytes);
}

export async function deriveRoomKey(secret, roomId) {
  const secretBytes = decodeBase64Url(secret);
  if (secretBytes.length !== 32) {
    throw new Error('The room secret must contain 256 bits.');
  }

  const keyMaterial = await crypto.subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveKey']);
  secretBytes.fill(0);

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
