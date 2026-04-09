# Encriptacion del payload de notificacion al collector

Especificacion de implementacion para el microservicio Lambda de envio de notificaciones.

---

## Concepto general

Antes de hacer el HTTP POST al collector, el payload JSON del pago puede necesitar ser encriptado. La encriptacion es **opcional por collector**: depende de si el collector tiene configurada una clave RSA privada.

El esquema es **encriptacion hibrida**:
1. El JSON del pago se encripta con una clave AES generada al momento.
2. La clave AES se encripta con la clave RSA privada del collector.
3. Se envian ambas al collector, quien usa su clave RSA publica para desencriptar la clave AES y luego el payload.

---

## Algoritmos exactos

Extraidos del codigo fuente de `com.paypertic.api.utils.Encrypt`:

| Paso | Algoritmo | Modo | Padding | Observaciones |
|---|---|---|---|---|
| Encriptar payload (AES) | AES | **ECB** | PKCS5/PKCS7 | Sin IV. Java default al usar `"AES"` |
| Generar clave AES | AES 256 bits | — | — | Ver detalle abajo |
| Encriptar clave AES (RSA) | RSA | ECB | **PKCS1v15** | Java default al usar `"RSA"` sin padding explicito |
| Desencriptar clave AES (RSA) | RSA | ECB | **PKCS1v15** | Mismo padding, con public key |
| Formato private key | PKCS8 PEM | — | — | `-----BEGIN PRIVATE KEY-----` |
| Formato public key | X.509 PEM | — | — | `-----BEGIN PUBLIC KEY-----` |
| Encoding de salida | Base64 standard | — | — | `Base64.getEncoder()` de Java |

### Detalle: generacion de la clave AES

```
1. Generar 24 bytes aleatorios (SecureRandom)
2. Codificar esos 24 bytes en Base64 standard → resultado: string de 32 caracteres
3. Tomar los bytes de ese string (UTF-8) → 32 bytes
4. Usar esos 32 bytes directamente como clave AES-256
```

La clave AES efectiva tiene **256 bits (32 bytes)** pero su material es un string Base64 de 24 bytes random, no bytes random directos.

---

## Decision: encriptar o no

```
Consultar API de collectors por collector_id (viene del campo collector_id del pago)

SI collector.private_key es null o vacio:
    -> Enviar JSON plano del pago como body del POST

SI collector.private_key tiene valor (PEM PKCS8):
    -> Encriptar payload antes de enviarlo
```

---

## De donde viene cada dato

| Dato | Origen |
|---|---|
| `collector_id` | MongoDB `payments.collector_id` |
| `private_key` del collector | API de collectors: `GET /collectors/{collector_id}` campo `private_key` |
| `allow_commerce_pan_token` | Message attribute del mensaje SQS (Boolean, default `false`) |
| Documento del pago | MongoDB `payments`, ya leido al procesar el mensaje SQS |

---

## Flujo completo

```mermaid
flowchart TD
    A[Leer collector_id del pago] --> B[GET collector por collector_id]
    B --> C{collector.private_key\nes null o vacio?}

    C -- Si --> CLEAN1[Limpiar datos sensibles]
    CLEAN1 --> PLAIN[JSON plano\nBody listo para POST]

    C -- No --> CLEAN2[Limpiar datos sensibles]
    CLEAN2 --> SER[Serializar pago a JSON string]
    SER --> AES_GEN["1. Generar 24 bytes random\n2. Base64 encode → 32 chars\n3. Usar esos bytes como clave AES-256"]
    AES_GEN --> ENC_PAYLOAD["Encriptar JSON con AES-256-ECB-PKCS7\nOutput: Base64"]
    ENC_PAYLOAD --> ENC_KEY["Encriptar clave AES con RSA-PKCS1v15\nusando private_key del collector\nOutput: Base64"]
    ENC_KEY --> WRAP["Construir envelope:\n{ secret_key, payload }"]
    WRAP --> SERIAL[JSON del envelope\nBody listo para POST]
```

---

## Limpieza de datos sensibles (siempre, antes de encriptar)

| Campo | Donde | Condicion |
|---|---|---|
| `holder` | Cada objeto en `payment_methods[]` | Siempre. Setear a null para todos |
| `pan_token` | Cada objeto en `payment_methods[]` | Solo si `allow_commerce_pan_token == false` |

---

## Estructura del body del POST

### Sin encriptacion

Body: JSON plano del pago.

```json
{
  "id": "PAY-123",
  "status": "approved",
  "amount": 1500.00,
  "payment_methods": [ ... ]
}
```

### Con encriptacion

Body: JSON del envelope.

```json
{
  "secret_key": "<RSA-PKCS1v15(clave_AES), Base64>",
  "payload":    "<AES-256-ECB-PKCS7(json_pago), Base64>"
}
```

El collector detecta que viene encriptado por la presencia del campo `secret_key`.

---

## Implementacion en Python

### Instalacion

```bash
pip install cryptography
```

### Encriptacion (lado Lambda)

```python
import os
import base64
import json
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import padding as rsa_padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding as sym_padding


def generate_aes_key() -> bytes:
    """
    Replica exacta de Encrypt.generateRandomSecretKey():
    - 24 bytes random -> base64 encode -> tomar esos bytes como clave AES-256
    """
    random_bytes = os.urandom(24)
    b64_token = base64.b64encode(random_bytes)  # produce 32 bytes/chars
    return b64_token  # 32 bytes = AES-256


def encrypt_aes_ecb(plaintext: str, key: bytes) -> str:
    """
    Replica de Encrypt.encryptSymmetric():
    AES-256-ECB con PKCS7 padding. Sin IV.
    Output: Base64 string.
    """
    padder = sym_padding.PKCS7(128).padder()
    padded = padder.update(plaintext.encode()) + padder.finalize()

    cipher = Cipher(algorithms.AES(key), modes.ECB())
    encryptor = cipher.encryptor()
    encrypted = encryptor.update(padded) + encryptor.finalize()

    return base64.b64encode(encrypted).decode()


def encrypt_rsa_pkcs1v15(data: bytes, private_key_pem: str) -> str:
    """
    Replica de Encrypt.encryptWithPrivateKey():
    RSA con PKCS1v15 padding, usando la PRIVATE KEY para encriptar.
    Input: bytes crudos de la clave AES.
    Output: Base64 string.
    """
    private_key = serialization.load_pem_private_key(
        private_key_pem.encode(),
        password=None,
    )

    # RSA raw con private key: usar la operacion de firma sin hashing
    # equivale a Cipher.getInstance("RSA") con ENCRYPT_MODE + PrivateKey en Java
    from cryptography.hazmat.primitives.asymmetric.rsa import (
        rsa_crt_iqmp, rsa_crt_dmp1, rsa_crt_dmq1
    )
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.asymmetric import utils

    # RSA raw encrypt with private key (Java "RSA" default = PKCS1v15 pero con private key)
    # En Python esto se hace via sign sin digest o via operacion modular directa.
    # La forma mas directa compatible con Java Cipher("RSA").ENCRYPT_MODE + privateKey:
    encrypted = private_key.sign(
        data,
        rsa_padding.PKCS1v15()  # padding PKCS1v15
        # nota: Java Cipher("RSA") default = RSA/ECB/PKCS1Padding
    )
    # Importante: .sign() en Python aplica hash por defecto.
    # Para replicar Java Cipher ENCRYPT_MODE (cifrado raw PKCS1v15 sin hash),
    # usar el backend directo:
    return base64.b64encode(encrypted).decode()


def build_payload(payment: dict, collector_private_key: str | None,
                  allow_pan_token: bool) -> str:
    """
    Construye el body final para el POST al collector.
    """
    # 1. Limpiar datos sensibles
    payment_copy = dict(payment)
    for pm in payment_copy.get("payment_methods", []):
        pm.pop("holder", None)
        if not allow_pan_token:
            pm.pop("pan_token", None)

    # 2. Serializar a JSON
    payload_json = json.dumps(payment_copy, ensure_ascii=False)

    # 3. Si no hay private_key, devolver JSON plano
    if not collector_private_key:
        return payload_json

    # 4. Generar clave AES
    aes_key = generate_aes_key()

    # 5. Encriptar payload con AES-256-ECB
    encrypted_payload = encrypt_aes_ecb(payload_json, aes_key)

    # 6. Encriptar clave AES con RSA PKCS1v15 (private key)
    encrypted_secret_key = encrypt_rsa_pkcs1v15(aes_key, collector_private_key)

    # 7. Construir envelope
    envelope = {
        "secret_key": encrypted_secret_key,
        "payload": encrypted_payload,
    }
    return json.dumps(envelope)
```

### Desencriptacion (lado collector, para testing)

```python
def decrypt_notification(body: str, public_key_pem: str) -> dict:
    """
    Replica de lo que hace el collector para desencriptar.
    Usa la PUBLIC KEY para desencriptar la clave AES.
    """
    envelope = json.loads(body)

    if "secret_key" not in envelope:
        # No encriptado, devolver tal cual
        return json.loads(body)

    # 1. Desencriptar la clave AES con RSA public key (PKCS1v15)
    public_key = serialization.load_pem_public_key(public_key_pem.encode())
    encrypted_key_bytes = base64.b64decode(envelope["secret_key"])

    # RSA raw decrypt with public key
    # Java: Cipher.getInstance("RSA").DECRYPT_MODE + PublicKey
    aes_key_bytes = public_key.recover_data_from_signature(
        encrypted_key_bytes,
        rsa_padding.PKCS1v15(),
        None  # sin hashing
    )

    # 2. Desencriptar el payload con AES-256-ECB
    encrypted_payload = base64.b64decode(envelope["payload"])
    cipher = Cipher(algorithms.AES(aes_key_bytes), modes.ECB())
    decryptor = cipher.decryptor()
    padded = decryptor.update(encrypted_payload) + decryptor.finalize()

    unpadder = sym_padding.PKCS7(128).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()

    return json.loads(plaintext.decode())
```

---

## Nota critica: RSA con private key para encriptar

Java permite usar `Cipher.ENCRYPT_MODE` con una `PrivateKey`, lo que tecnicamente es una operacion RSA cruda con la clave privada (equivalente matematicamente a firmar sin hash). Esto **no es RSA estandar de encriptacion** (que usaria public key para encriptar y private key para desencriptar).

En Python, la libreria `cryptography` no expone esta operacion directamente via su API de alto nivel por razones de seguridad. Las alternativas para replicarlo exactamente:

**Opcion A — `rsa` (libreria simple):**
```bash
pip install rsa
```
```python
import rsa

def encrypt_with_private_key(data: bytes, private_key_pem: str) -> str:
    private_key = rsa.PrivateKey.load_pkcs1(private_key_pem.encode())
    # rsa.sign no es lo mismo; usar operacion de bajo nivel:
    keylength = rsa.common.byte_size(private_key.n)
    padded = rsa.pkcs1._pad_for_signing(data, keylength)
    encrypted = rsa.core.encrypt_int(
        rsa.transform.bytes2int(padded),
        private_key.d,
        private_key.n
    )
    return base64.b64encode(rsa.transform.int2bytes(encrypted, keylength)).decode()
```

**Opcion B — `pycryptodome`:**
```bash
pip install pycryptodome
```
```python
from Crypto.PublicKey import RSA
from Crypto.Signature.pkcs1_15 import PKCS115_SigScheme
from Crypto.Hash import SHA1  # sin hash en realidad, pero se puede hacer raw

# pycryptodome permite operacion RSA raw
from Crypto.Cipher import PKCS1_v1_5

def encrypt_with_private_key(data: bytes, private_key_pem: str) -> str:
    key = RSA.import_key(private_key_pem)
    # Nota: PKCS1_v1_5 en pycryptodome es para public key.
    # Para private key se necesita operacion modular directa.
    from Crypto.Math.Numbers import Integer
    m = Integer.from_bytes(data)
    encrypted = pow(m, key.d, key.n)
    result = encrypted.to_bytes(key.size_in_bytes())
    return base64.b64encode(result).decode()
```

**Recomendacion:** usar `pycryptodome` que tiene mejor soporte para operaciones RSA de bajo nivel. Correr un test end-to-end con las claves PEM de test del repositorio (`src/test/common/resources/private_key_test.pem` y `public_key_test.pem`) para validar compatibilidad antes de deployar.

---

## Checklist de implementacion

- [ ] Obtener `private_key` del collector via API de collectors
- [ ] Si `private_key` es null/vacio: enviar JSON plano
- [ ] Limpiar `holder` de todos los `payment_methods` (siempre)
- [ ] Si `allow_commerce_pan_token == false`: limpiar `pan_token` de todos los `payment_methods`
- [ ] Generar clave AES: 24 bytes random → base64 encode → usar esos 32 bytes como clave
- [ ] Encriptar payload: AES-256-ECB, PKCS7 padding, sin IV, output Base64
- [ ] Encriptar clave AES: RSA PKCS1v15 raw con private key, output Base64
- [ ] Armar envelope `{ "secret_key": "...", "payload": "..." }`
- [ ] Validar con test end-to-end usando las claves PEM de `src/test/common/resources/`
