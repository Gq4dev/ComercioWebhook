# Encriptacion del payload de notificacion al collector

Especificacion de implementacion para el microservicio Lambda de envio de notificaciones.

---

## Concepto general

Antes de hacer el HTTP POST al collector, el payload JSON del pago puede necesitar ser encriptado. La encriptacion es **opcional por collector**: depende de si el collector tiene configurada una clave RSA privada.

El esquema es **encriptacion hibrida**:
- El contenido (JSON del pago) se encripta con una clave AES generada al momento.
- La clave AES se encripta con la clave RSA privada del collector.
- Se envian ambas cosas al collector, quien usa su clave RSA publica para desencriptar la clave AES y luego el contenido.

---

## Decision: encriptar o no

```
Consultar collectors API o tabla de configuracion del collector
  -> Buscar por collector_id (viene del campo collector_id del pago en MongoDB)

SI collector.private_key es null o vacio:
    -> Enviar JSON plano del pago directamente como body del POST

SI collector.private_key tiene valor:
    -> Encriptar payload antes de enviarlo
```

---

## De donde viene cada dato

| Dato | Origen | Como obtenerlo |
|---|---|---|
| `collector_id` | MongoDB, coleccion `payments`, campo `collector_id` | Viene del documento del pago que ya se leyo al procesar el mensaje SQS |
| `private_key` del collector | API de collectors (o cache) | `GET /collectors/{collector_id}` -> campo `private_key` |
| `allow_commerce_pan_token` | Atributo del mensaje SQS | Message attribute `allow_commerce_pan_token` (Boolean, default false) |
| Payload del pago | MongoDB, coleccion `payments` | El mismo documento leido para las validaciones |

---

## Flujo completo

```mermaid
flowchart TD
    A[Leer collector_id del pago] --> B["GET collector por collector_id\n(API o cache)"]
    B --> C{collector.private_key\nes null o vacio?}

    C -- "Si" --> CLEAN1[Limpiar datos sensibles del pago]
    CLEAN1 --> PLAIN[Serializar pago a JSON\nBody listo para POST]

    C -- "No" --> CLEAN2[Limpiar datos sensibles del pago]
    CLEAN2 --> SER[Serializar pago a JSON]
    SER --> AES[Generar clave AES aleatoria]
    AES --> ENC_PAYLOAD[Encriptar JSON del pago\ncon clave AES]
    ENC_PAYLOAD --> ENC_KEY[Encriptar clave AES\ncon private_key RSA del collector]
    ENC_KEY --> WRAP["Construir envelope:\n{ secret_key, payload }"]
    WRAP --> SERIAL[Serializar envelope a JSON\nBody listo para POST]
```

---

## Limpieza de datos sensibles (siempre, antes de encriptar)

Independientemente de si se encripta o no, hay que limpiar el modelo del pago antes de serializarlo.

**Campos a eliminar del payload:**

| Campo | Donde esta | Condicion |
|---|---|---|
| `holder` | Dentro de cada objeto en `payment_methods[]` | Siempre. Remover para todos los metodos de pago |
| `pan_token` | Dentro de cada objeto en `payment_methods[]` | Solo si `allow_commerce_pan_token == false` |

`allow_commerce_pan_token` viene del atributo del mensaje SQS. Si el atributo no esta presente en el mensaje, el valor por defecto es `false` (no incluir pan_token).

---

## Proceso de encriptacion paso a paso

### 1. Serializar el pago a JSON

Tomar el documento del pago ya limpio de datos sensibles y convertirlo a JSON string. Este es el contenido que se va a proteger.

### 2. Generar una clave AES aleatoria

Generar una clave simetrica AES nueva para esta notificacion puntual. No reutilizar claves entre notificaciones.

- Algoritmo: **AES**
- Tamaño de clave recomendado: 128 o 256 bits (verificar con la implementacion existente de la libreria `com.paypertic.api.utils.Encrypt`)

### 3. Encriptar el JSON del pago con AES

```
Input:   string JSON del pago (plaintext)
Key:     clave AES del paso anterior
Output:  string encriptado, codificado en Base64
```

### 4. Encriptar la clave AES con la private key RSA del collector

```
Input:   bytes de la clave AES (raw bytes, no Base64)
Key:     private_key del collector (string PEM, formato PKCS8: -----BEGIN PRIVATE KEY-----)
Output:  string encriptado, codificado en Base64
```

### 5. Construir el envelope JSON

```json
{
  "secret_key": "<clave AES encriptada en Base64>",
  "payload": "<JSON del pago encriptado en Base64>"
}
```

Este JSON es el body final del HTTP POST.

---

## HTTP POST al collector

Independientemente de si el payload esta encriptado o no, la request es la misma:

```
Method:  POST
URL:     payments.notification_url
Headers: Content-Type: application/json
Body:    (ver abajo segun escenario)
```

### Sin encriptacion

```json
{
  "id": "PAY-123",
  "status": "approved",
  "amount": 1500.00,
  ...
}
```

### Con encriptacion

```json
{
  "secret_key": "base64encodedEncryptedAESKey...",
  "payload": "base64encodedEncryptedPayload..."
}
```

El collector detecta que esta encriptado por la presencia del campo `secret_key`.

---

## Como desencripta el collector (referencia)

Documentado para testing y para compartir con collectors que necesiten implementar su lado:

1. Parsear el body. Si tiene el campo `secret_key`, esta encriptado.
2. Desencriptar `secret_key` (Base64 decode primero) usando su **clave RSA publica**.
3. Usar los bytes resultantes como clave AES.
4. Desencriptar `payload` usando la clave AES.
5. Parsear el JSON resultante como el objeto Payment/Subscription.

---

## Donde vive la private_key del collector

La `private_key` esta almacenada en el sistema de collectors (no en MongoDB de pagos). Se obtiene via la API de collectors usando el `collector_id` del pago.

**El par de claves RSA lo genera el collector** (o el sistema al dar de alta al collector). El sistema guarda la `private_key`, el collector guarda su `public_key` para poder desencriptar las notificaciones que recibe.

> Nota: el nombre `private_key` puede resultar contraintuitivo. En este esquema el servidor usa la "private key" para encriptar (en lugar del uso clasico RSA donde la private key desencripta). El collector desencripta con su "public key". Es un esquema inverso al RSA convencional. Verificar con la implementacion de `Encrypt.encryptWithPrivateKey` y `Encrypt.decryptWithPublicKey` de la libreria compartida para asegurar compatibilidad exacta de algoritmos.

---

## Checklist de implementacion

### Datos a obtener antes de encriptar

- [ ] `collector_id` del pago (campo `collector_id` en `payments`)
- [ ] `private_key` del collector (API de collectors)
- [ ] `allow_commerce_pan_token` del mensaje SQS (atributo, default `false`)

### Preparacion del payload

- [ ] Remover `holder` de todos los `payment_methods`
- [ ] Si `allow_commerce_pan_token == false`: remover `pan_token` de todos los `payment_methods`
- [ ] Serializar el pago limpio a JSON

### Encriptacion (solo si collector tiene private_key)

- [ ] Generar clave AES aleatoria por cada notificacion
- [ ] Encriptar el JSON con AES → resultado en Base64
- [ ] Encriptar la clave AES con RSA private_key → resultado en Base64
- [ ] Armar el envelope `{ "secret_key": "...", "payload": "..." }`
- [ ] Serializar el envelope a JSON como body final

### Envio

- [ ] `POST` a `payments.notification_url`
- [ ] Header `Content-Type: application/json`
- [ ] Timeout configurado (cualquier excepcion de red = response code 500 para las validaciones de reintento)

### Testing

- [ ] Test sin `private_key`: el body recibido es JSON plano del pago
- [ ] Test con `private_key`: el body recibido tiene `secret_key` y `payload`
- [ ] Test de desencriptacion end-to-end: encriptar con private key de test y verificar que se puede desencriptar con la public key de test
- [ ] Test: `pan_token` no aparece en el payload cuando `allow_commerce_pan_token = false`
- [ ] Test: `pan_token` aparece en el payload cuando `allow_commerce_pan_token = true`
- [ ] Test: `holder` nunca aparece en el payload
