import { createMessageMetadata, serializeEnvelope } from './messageEnvelope.js';
import { decodeBase64Url, encodeBase64Url } from './keyDerivation.js';

const encoder = new TextEncoder();

export async function encryptMessage(text, key, roomId, sender) {
  if (typeof text !== 'string' || text.length === 0 || text.length > 8_000) {
    throw new Error('Messages must contain between 1 and 8,000 characters.');
  }
  const plaintext = encoder.encode(text);
  if (plaintext.length > 32_000) throw new Error('Message is too large to send.');

  const envelope = createMessageMetadata(sender);
  const additionalData = encoder.encode(
    `securecode:v1|${roomId}|${envelope.id}|${envelope.sender}|${envelope.createdAt}`,
  );
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64Url(envelope.nonce),
      additionalData,
      tagLength: 128,
    },
    key,
    plaintext,
  );
  envelope.ciphertext = encodeBase64Url(new Uint8Array(encrypted));
  return { envelope, serialized: serializeEnvelope(envelope) };
}
