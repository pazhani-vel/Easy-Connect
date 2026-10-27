import { decodeBase64Url } from './keyDerivation.js';
import { deserializeEnvelope } from './messageEnvelope.js';

const encoder = new TextEncoder();

export async function decryptMessage(serialized, key, roomId) {
  const envelope = deserializeEnvelope(serialized);
  const additionalData = encoder.encode(
    `securecode:v1|${roomId}|${envelope.id}|${envelope.sender}|${envelope.createdAt}`,
  );
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64Url(envelope.nonce),
      additionalData,
      tagLength: 128,
    },
    key,
    decodeBase64Url(envelope.ciphertext),
  );
  return {
    ...envelope,
    text: new TextDecoder('utf-8', { fatal: true }).decode(plaintext),
  };
}
