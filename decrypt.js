const forge = require('node-forge');

/**
 * Returns true when the body looks like an encrypted envelope
 * from the Lambda (has both secret_key and payload fields).
 */
function isEncryptedPayload(body) {
  return (
    body != null &&
    typeof body === 'object' &&
    typeof body.secret_key === 'string' &&
    typeof body.payload === 'string'
  );
}

/**
 * Wrap a raw-Base64 key (no PEM headers) into PEM format.
 */
function toPem(rawBase64, label) {
  const lines = rawBase64.match(/.{1,64}/g) || [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----`;
}

/**
 * RSA "decrypt with public key" — inverse of Java
 * Cipher("RSA").init(ENCRYPT_MODE, privateKey).
 *
 * Mathematically: m = c^e mod n, then strip PKCS#1 v1.5 type-1 padding.
 *
 * Java uses type-1 padding (0x00 0x01 0xFF…0xFF 0x00 <data>) when
 * encrypting with a PrivateKey.  The collector decrypts with the
 * matching PublicKey by raising to exponent e and stripping that padding.
 */
function rsaPublicDecrypt(encryptedBase64, publicKeyPem) {
  const publicKey = forge.pki.publicKeyFromPem(publicKeyPem);
  const encBytes = forge.util.decode64(encryptedBase64);

  // c^e mod n
  const c = new forge.jsbn.BigInteger(forge.util.bytesToHex(encBytes), 16);
  const m = c.modPow(publicKey.e, publicKey.n);

  const keyByteLen = Math.ceil(publicKey.n.bitLength() / 8);
  let hex = m.toString(16);
  while (hex.length < keyByteLen * 2) hex = '0' + hex;
  const dec = forge.util.hexToBytes(hex);

  // Strip PKCS#1 v1.5 type-1 padding: 0x00 0x01 [0xFF…] 0x00 <data>
  if (dec.charCodeAt(0) !== 0x00 || dec.charCodeAt(1) !== 0x01) {
    throw new Error('Invalid PKCS#1 v1.5 padding: expected 0x00 0x01 header');
  }
  let idx = 2;
  while (idx < dec.length && dec.charCodeAt(idx) === 0xFF) idx++;
  if (idx >= dec.length || dec.charCodeAt(idx) !== 0x00) {
    throw new Error('Invalid PKCS#1 v1.5 padding: missing 0x00 separator');
  }
  idx++; // skip separator

  return dec.substring(idx); // binary string with the AES key bytes
}

/**
 * Decrypt AES-256-ECB with PKCS7 padding (matches Java "AES" default).
 * Returns the plaintext UTF-8 string.
 */
function decryptAesEcb(encryptedBase64, aesKeyBinaryStr) {
  const encBytes = forge.util.decode64(encryptedBase64);
  const decipher = forge.cipher.createDecipher('AES-ECB', aesKeyBinaryStr);
  decipher.start();
  decipher.update(forge.util.createBuffer(encBytes));
  const ok = decipher.finish();
  if (!ok) {
    throw new Error('AES-ECB decryption failed (bad padding or key)');
  }
  return decipher.output.toString('utf8');
}

/**
 * Decrypt a full encrypted envelope { secret_key, payload } using
 * the collector's RSA public key.
 *
 * @param {{ secret_key: string, payload: string }} body
 * @returns {object} The decrypted payment/subscription JSON object.
 */
function decryptPayload(body) {
  const rawPublicKey = process.env.COLLECTOR_RSA_PUBLIC_KEY;
  if (!rawPublicKey) {
    throw new Error(
      'COLLECTOR_RSA_PUBLIC_KEY env var is not set — cannot decrypt payload'
    );
  }

  const publicKeyPem = toPem(rawPublicKey, 'PUBLIC KEY');

  // 1. Decrypt the AES key with RSA public key
  const aesKey = rsaPublicDecrypt(body.secret_key, publicKeyPem);

  // 2. Decrypt the payload with AES-256-ECB
  const jsonString = decryptAesEcb(body.payload, aesKey);

  // 3. Parse and return
  return JSON.parse(jsonString);
}

module.exports = { isEncryptedPayload, decryptPayload, rsaPublicDecrypt, decryptAesEcb, toPem };
