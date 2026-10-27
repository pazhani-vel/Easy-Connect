import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptMessage } from './decrypt.js';
import { encryptMessage } from './encrypt.js';
import { decodeBase64Url, deriveRoomKey, encodeBase64Url, randomRoomSecret } from './keyDerivation.js';
import { deserializeEnvelope, serializeEnvelope } from './messageEnvelope.js';

const roomId = 'MDEyMzQ1Njc4OWFiY2RlZg';

test('only the correct room secret decrypts an encrypted message', async () => {
  const secret = randomRoomSecret();
  const key = await deriveRoomKey(secret, roomId);
  const wrongKey = await deriveRoomKey(randomRoomSecret(), roomId);
  const { serialized } = await encryptMessage('sensitive multiline\ntext', key, roomId, 'owner');

  assert.equal((await decryptMessage(serialized, key, roomId)).text, 'sensitive multiline\ntext');
  await assert.rejects(decryptMessage(serialized, wrongKey, roomId));
});

test('tampering with ciphertext or authenticated metadata fails AES-GCM verification', async () => {
  const key = await deriveRoomKey(randomRoomSecret(), roomId);
  const { envelope } = await encryptMessage('authenticated content', key, roomId, 'peer');
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  ciphertext[0] ^= 1;
  const tamperedCiphertext = serializeEnvelope({
    ...envelope,
    ciphertext: encodeBase64Url(ciphertext),
  });
  await assert.rejects(decryptMessage(tamperedCiphertext, key, roomId));

  const tamperedMetadata = serializeEnvelope({ ...envelope, createdAt: envelope.createdAt + 1 });
  await assert.rejects(decryptMessage(tamperedMetadata, key, roomId));
});

test('every encryption uses a distinct cryptographically random nonce', async () => {
  const key = await deriveRoomKey(randomRoomSecret(), roomId);
  const first = await encryptMessage('first', key, roomId, 'owner');
  const second = await encryptMessage('second', key, roomId, 'owner');
  assert.equal(decodeBase64Url(first.envelope.nonce).length, 12);
  assert.notEqual(first.envelope.nonce, second.envelope.nonce);
});

test('the serialized envelope validates protocol metadata and rejects malformed envelopes', async () => {
  const key = await deriveRoomKey(randomRoomSecret(), roomId);
  const { serialized, envelope } = await encryptMessage('plain text remains local', key, roomId, 'owner');
  assert.deepEqual(deserializeEnvelope(serialized), envelope);
  assert.equal(serialized.includes('plain text remains local'), false);
  assert.throws(() => deserializeEnvelope('{"version":1}'));
});

test('derived AES keys are non-extractable and are bound to their room identifier', async () => {
  const secret = randomRoomSecret();
  const firstRoomKey = await deriveRoomKey(secret, roomId);
  const otherRoomKey = await deriveRoomKey(secret, `${roomId}x`);
  assert.equal(firstRoomKey.algorithm.name, 'AES-GCM');
  assert.equal(firstRoomKey.algorithm.length, 256);
  assert.equal(firstRoomKey.extractable, false);
  assert.deepEqual(firstRoomKey.usages, ['encrypt', 'decrypt']);

  const { serialized } = await encryptMessage('room-bound ciphertext', firstRoomKey, roomId, 'owner');
  await assert.rejects(decryptMessage(serialized, otherRoomKey, roomId));
  await assert.rejects(decryptMessage(serialized, firstRoomKey, `${roomId}x`));
});

test('room secret generation and derivation reject malformed or wrong-length secrets', async () => {
  const secret = randomRoomSecret();
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(decodeBase64Url(secret).length, 32);
  for (const invalidSecret of ['', 'A'.repeat(42), 'A'.repeat(44), '!'.repeat(43)]) {
    await assert.rejects(deriveRoomKey(invalidSecret, roomId));
  }
});

test('encryption preserves Unicode, newlines, and the maximum supported message size', async () => {
  const key = await deriveRoomKey(randomRoomSecret(), roomId);
  const text = `🔐e\u0301\n${'x'.repeat(7_995)}`;
  const encrypted = await encryptMessage(text, key, roomId, 'peer');
  assert.equal((await decryptMessage(encrypted.serialized, key, roomId)).text, text);
  await assert.rejects(encryptMessage(`${'x'.repeat(8_000)}x`, key, roomId, 'peer'));
  await assert.rejects(encryptMessage('', key, roomId, 'peer'));
  await assert.rejects(encryptMessage('text', key, roomId, 'admin'));
});

test('envelope deserialization rejects wrong types, extra fields, and oversized envelopes', () => {
  const envelope = {
    version: 1,
    id: '10000000-0000-4000-8000-000000000001',
    nonce: 'A'.repeat(16),
    ciphertext: 'A'.repeat(22),
    createdAt: Date.now(),
    sender: 'owner',
  };
  for (const malformed of [
    { ...envelope, sender: 'peer\n<script>' },
    { ...envelope, createdAt: Number.MAX_SAFE_INTEGER + 1 },
    { ...envelope, id: 'not-a-uuid' },
    { ...envelope, nonce: 'A'.repeat(15) },
    { ...envelope, ciphertext: 'A'.repeat(44_001) },
    { ...envelope, extra: true },
  ]) {
    assert.throws(() => deserializeEnvelope(JSON.stringify(malformed)));
  }
  assert.throws(() => deserializeEnvelope('x'.repeat(48 * 1024 + 1)));
});

test('base64url helpers round-trip arbitrary bytes and reject invalid input', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(64));
  assert.deepEqual(decodeBase64Url(encodeBase64Url(bytes)), bytes);
  assert.throws(() => decodeBase64Url('invalid+base64'));
});
