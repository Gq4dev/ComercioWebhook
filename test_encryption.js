/**
 * Test E2E de encriptacion/desencriptacion.
 *
 * Simula lo que hace la Lambda:
 *   1. Genera clave AES (24 random bytes -> Base64 -> 32 bytes)
 *   2. Encripta JSON del pago con AES-256-ECB + PKCS7
 *   3. Encripta la clave AES con RSA PKCS1v15 usando private_key
 *   4. POST { secret_key, payload } al webhook
 *
 * Uso:
 *   node test_encryption.js [url]
 *   url default: http://localhost:3001/webhook
 */

const forge = require('node-forge');
const http = require('http');
const https = require('https');
const { toPem, rsaPublicDecrypt, decryptAesEcb } = require('./decrypt');

const WEBHOOK_URL = process.argv[2] || 'http://localhost:3001/webhook';

// Private key del collector 3391 (raw Base64, sin PEM headers)
const PRIVATE_KEY_RAW = 'MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDG2aydOMv7q3UAMBzftCTsrWBUDvAdLZgQkUqHIZ0JTCIuYlQpZ3VcuM60C68C/FanA1x96yptl6XoVRDKDmqS/Pp/yRg/sTlEw3nE6XKgT5N80p+I7xyDng4dDL7SINgEqawD0j3zWutm2LVw7rhUb/8xrtgNlAm0AtlfDTzHkeDUHaeCP3YzyK6DGViO/15hcC/WZzL9g5IWHBVa253JIov7nqSh6EDqwKLbhy3hqtfzpjuGGXxuFeUey/7920YlQzm3nw7OwU76xRCTJtsVes1Tuo2Ijq53e+jZ5rRcgZ6nlWCRQkSHeWOOSOTt5o3tkME+R0ztSQyB4bflbpd/AgMBAAECggEBALlFuyTJ9JTKjbrdGSn9aKH0cFohiOtGvfZByRTa5rvw6bAaAZyKPrljn4P1ltzLS9lUsmrIH8H4l6Y/C+OXRwkpGCTTsvo1H8zH7L7hW+GuAxc8D1TApOqk6zV52Jlj7KF7jUAKNZp2TfqHU5ajda+GolkiNT+BfQDx3qJHbSfrSPqHcgZNGwvBq6qa0Ib348xlaL8jKYfy443plqvzm/Tce9biqIp/xFi1MFja6tEXsufZ8L5IFLf1n0YizBTc0mNsfMdRHs1WOmOLDAs3tfKptht3OVCP8JdKaSyOcgr7wEkIZTBawI/3/pZ9LMnRCJ1kxh5zXSUvv7g9/O8g3PECgYEA5Men0eyk0vLjx8vpGxIbHqW3gSMvBzeNVJv8B2myFpNzczSDAtx4C/zUncOB9KFhop/bzCSUBjH9Z/fdKBca1WHz/JbcNmKiQUlFkwNSqRm7dLqYOhTN0BXwyseVEaZVHuO1Ez5HP76Zg4R2MCYnpp0B5iLWee1wGi/EoZbvWMMCgYEA3oJmmt/OTMjaRYXQ5h4uowJxcp6tPzAntpgHiNVXAiOYidWUBmb20JF662+P4u2mgeAIjE7YO8zRZXc34Sygu1qpfB3GySsTPYN1cnNhP/fGQIUn1wmg6tPVhfcNf0moNHLQ+TY8voY+37wHXdMQ7E1KXIxnj4HCeJ8/ax+xepUCgYARjGsIBDHkaHMmaTK5O9tOr4Fy62L5F77Eha6AVxAtASRy6s090/F1YfBhJZT7UcGuerqeXxPnocABUJbrM1KAmaHgdyXvGgO+JEOs8i1OAUZKvuFcWyoqUvSEaWi60NpooyjJkBZhAlq+JtP1/4c9FYAGyhdPhPH7YDyh9HTphwKBgQCzk9JzVAUPe1qNmX4K+njxHlupAd8YjCjA+Nm72VIra8cEFtcsg5TWp1LpCFS79MjZMJI1iryBJsAof5sdpALksjru7KkuWhFhJ+N1xyDJm5LpJ44Lwr2YR/af889012FlUvTM7LUBnx7HOt1HH70cuRQ2tSova64j44IvVpjKMQKBgFNuEc+Q5qSsVeWy7sHRH/6JmBbXqepM8FS6synZFxxOJmQYl67Fb8hBvPY7WmSTox5PVhmIYRb2Y1/8WMdz7wcjK9hicNuVbBkEEVhTVm4AFbC+8o2jMLsI/cQ56O+FtYX25aqypXfxa05ZBmxFu7sgG7HM001YKVkgdR1vUFBm';

const PUBLIC_KEY_RAW = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAxtmsnTjL+6t1ADAc37Qk7K1gVA7wHS2YEJFKhyGdCUwiLmJUKWd1XLjOtAuvAvxWpwNcfesqbZel6FUQyg5qkvz6f8kYP7E5RMN5xOlyoE+TfNKfiO8cg54OHQy+0iDYBKmsA9I981rrZti1cO64VG//Ma7YDZQJtALZXw08x5Hg1B2ngj92M8iugxlYjv9eYXAv1mcy/YOSFhwVWtudySKL+56koehA6sCi24ct4arX86Y7hhl8bhXlHsv+/dtGJUM5t58OzsFO+sUQkybbFXrNU7qNiI6ud3vo2ea0XIGep5VgkUJEh3ljjkjk7eaN7ZDBPkdM7UkMgeG35W6XfwIDAQAB';

// Pago de ejemplo (formato Paytic real)
const SAMPLE_PAYMENT = {
  type: 'debit',
  id: 'encrypted-test-' + Date.now(),
  external_transaction_id: '0054802512977046000012689220250801301242test',
  collector_id: '39501',
  collector_detail: {
    name: 'Prueba Best Encriptado',
    public_email: 'prueba@pagotic.com'
  },
  details: [{
    amount: 2500.00,
    external_reference: 'test-ref-001',
    concept_id: 'test-enc',
    concept_description: 'Pago encriptado de prueba',
    collector_id: '39501'
  }],
  currency_id: 'ARS',
  payment_methods: [{
    type: 'debit',
    amount: 2500.00,
    final_amount: 2500.00,
    media_payment_detail: 'VISA DEBIT',
    last_four_digits: '1234',
    gateway: {
      id: 36,
      status: 'approved',
      name: 'WORLDPAY',
      transaction_id: 'gw-test-' + Date.now()
    },
    currency_id: 'ARS'
  }],
  payer: {
    name: 'Test Encriptado',
    email: 'test@pagotic.com'
  },
  final_amount: 2500.00,
  status: 'approved',
  status_detail: 'accredited',
  process_date: new Date().toISOString().replace(/\.\d{3}Z$/, '+0000'),
  last_update_date: new Date().toISOString().replace(/\.\d{3}Z$/, '+0000')
};

// --- Encryption (simulates Lambda) ---

function generateAesKey() {
  const randomBytes = forge.random.getBytesSync(24);
  return forge.util.encode64(randomBytes); // 32-char string = 32 bytes as AES key
}

function encryptAesEcb(plaintext, aesKeyString) {
  const key = aesKeyString; // 32 bytes binary string (ASCII chars of the base64 token)
  const cipher = forge.cipher.createCipher('AES-ECB', key);
  cipher.start();
  cipher.update(forge.util.createBuffer(plaintext, 'utf8'));
  cipher.finish();
  return forge.util.encode64(cipher.output.getBytes());
}

function rsaPrivateEncrypt(dataStr, privateKeyPem) {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const keyByteLen = Math.ceil(privateKey.n.bitLength() / 8);

  // PKCS#1 v1.5 type 1 padding: 0x00 0x01 [0xFF…] 0x00 <data>
  const dataLen = dataStr.length;
  const paddingLen = keyByteLen - dataLen - 3;
  if (paddingLen < 8) throw new Error('Data too long for RSA key size');

  let padded = String.fromCharCode(0x00, 0x01);
  for (let i = 0; i < paddingLen; i++) padded += String.fromCharCode(0xFF);
  padded += String.fromCharCode(0x00);
  padded += dataStr;

  // m^d mod n
  const m = new forge.jsbn.BigInteger(forge.util.bytesToHex(padded), 16);
  const c = m.modPow(privateKey.d, privateKey.n);

  let hex = c.toString(16);
  while (hex.length < keyByteLen * 2) hex = '0' + hex;
  return forge.util.encode64(forge.util.hexToBytes(hex));
}

function buildEncryptedEnvelope(paymentObj, privateKeyPem) {
  const json = JSON.stringify(paymentObj);

  // 1. Generate AES key (Java style: 24 random -> base64 -> use those 32 bytes)
  const aesKey = generateAesKey();

  // 2. AES-256-ECB encrypt the JSON
  const encryptedPayload = encryptAesEcb(json, aesKey);

  // 3. RSA encrypt the AES key with private key (PKCS1v15 type 1)
  const encryptedSecretKey = rsaPrivateEncrypt(aesKey, privateKeyPem);

  return { secret_key: encryptedSecretKey, payload: encryptedPayload };
}

// --- HTTP helper (works on Node 16+) ---

function postJson(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(parsed, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(chunks)); } catch (e) { reject(new Error('Bad JSON: ' + chunks)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// --- Tests ---

async function testLocalRoundTrip() {
  console.log('=== Test 1: Round-trip local (encrypt + decrypt) ===\n');

  const privateKeyPem = toPem(PRIVATE_KEY_RAW, 'PRIVATE KEY');
  const publicKeyPem = toPem(PUBLIC_KEY_RAW, 'PUBLIC KEY');

  // Encrypt
  const json = JSON.stringify(SAMPLE_PAYMENT);
  const aesKey = generateAesKey();
  console.log('AES key (32 chars):', aesKey);

  const encPayload = encryptAesEcb(json, aesKey);
  const encSecretKey = rsaPrivateEncrypt(aesKey, privateKeyPem);

  // Decrypt
  const decryptedAesKey = rsaPublicDecrypt(encSecretKey, publicKeyPem);
  console.log('Decrypted AES key:', decryptedAesKey);
  console.log('Keys match:', aesKey === decryptedAesKey);

  if (aesKey !== decryptedAesKey) {
    console.error('FAIL: AES keys do not match!');
    process.exit(1);
  }

  const decryptedJson = decryptAesEcb(encPayload, decryptedAesKey);
  const decryptedObj = JSON.parse(decryptedJson);
  console.log('Decrypted payer:', decryptedObj.payer?.name);
  console.log('Decrypted amount:', decryptedObj.final_amount);
  console.log('Round-trip: PASS\n');
}

async function testWebhookPost() {
  console.log('=== Test 2: POST encrypted payload to webhook ===\n');

  const privateKeyPem = toPem(PRIVATE_KEY_RAW, 'PRIVATE KEY');
  const envelope = buildEncryptedEnvelope(SAMPLE_PAYMENT, privateKeyPem);

  console.log('Sending encrypted envelope to', WEBHOOK_URL);
  console.log('  secret_key length:', envelope.secret_key.length, 'chars');
  console.log('  payload length:', envelope.payload.length, 'chars');

  try {
    const body = await postJson(WEBHOOK_URL, envelope);
    console.log('  Response body:', JSON.stringify(body, null, 2));

    if (body.success) {
      console.log('\nWebhook E2E: PASS');
    } else {
      console.error('\nWebhook E2E: FAIL');
      process.exit(1);
    }
  } catch (err) {
    console.error('  Error:', err.message);
    console.error('\nWebhook E2E: FAIL (is the server running?)');
    process.exit(1);
  }
}

async function testPlainStillWorks() {
  console.log('\n=== Test 3: Plain JSON (unencrypted) still works ===\n');

  const plain = {
    id: 'plain-test-' + Date.now(),
    amount: 100,
    currency: 'ARS',
    status: 'approved',
    payer: 'Plain User'
  };

  try {
    const body = await postJson(WEBHOOK_URL, plain);
    console.log('  Response body:', JSON.stringify(body, null, 2));

    if (body.success) {
      console.log('\nPlain JSON: PASS');
    } else {
      console.error('\nPlain JSON: FAIL');
    }
  } catch (err) {
    console.error('  Error:', err.message);
  }
}

async function run() {
  console.log('Encryption E2E Test Suite\n');
  await testLocalRoundTrip();
  await testWebhookPost();
  await testPlainStillWorks();
  console.log('\n=== All tests complete ===');
}

run().catch(console.error);
