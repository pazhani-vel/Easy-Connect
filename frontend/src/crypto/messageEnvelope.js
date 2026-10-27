import { decodeBase64Url, encodeBase64Url } from './keyDerivation.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function createMessageMetadata(sender) {
  if (sender !== 'owner' && sender !== 'peer') throw new Error('Invalid sender role.');
  return {
    version: 1,
    id: crypto.randomUUID(),
    nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(12))),
    createdAt: Date.now(),
    sender,
  };
}

export function serializeEnvelope(envelope) {
  if (!isValidEnvelope(envelope)) throw new Error('Cannot serialize an invalid message envelope.');
  return JSON.stringify(envelope);
}

export function deserializeEnvelope(serialized) {
  if (typeof serialized !== 'string' || serialized.length > 48 * 1024) {
    throw new Error('Invalid message envelope.');
  }
  let envelope;
  try {
    envelope = JSON.parse(serialized);
  } catch {
    throw new Error('Invalid message envelope.');
  }
  if (!isValidEnvelope(envelope)) throw new Error('Invalid message envelope.');
  return envelope;
}

export function isValidEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort().join(',');
  if (keys !== 'ciphertext,createdAt,id,nonce,sender,version') return false;
  if (value.version !== 1 || !uuidPattern.test(value.id)) return false;
  if (value.sender !== 'owner' && value.sender !== 'peer') return false;
  if (!Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || value.createdAt > 8_640_000_000_000_000) return false;
  if (typeof value.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/u.test(value.nonce)) return false;
  if (typeof value.ciphertext !== 'string' || value.ciphertext.length < 22 || value.ciphertext.length > 44_000) {
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(value.ciphertext)) return false;
  try {
    return decodeBase64Url(value.nonce).length === 12;
  } catch {
    return false;
  }
}
