/** Desempaqueta montos tipo Mongo EJSON / strings (útil si amount llegó mal al estado). */
function unwrapNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim().replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object') {
    if (v.$numberDecimal != null) return unwrapNumber(String(v.$numberDecimal));
    if (v.$numberDouble != null) return unwrapNumber(v.$numberDouble);
    if (v.$numberLong != null) return unwrapNumber(String(v.$numberLong));
    if (v.$numberInt != null) return unwrapNumber(v.$numberInt);
  }
  return null;
}

function amountFromDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  const keys = [
    'amount',
    'final_amount',
    'total_amount',
    'transaction_amount',
    'paid_amount',
    'total_paid_amount',
    'monto'
  ];
  for (const k of keys) {
    const n = unwrapNumber(doc[k]);
    if (n != null) return n;
  }
  const td = doc.transaction_details;
  if (td && typeof td === 'object') {
    for (const k of keys) {
      const n = unwrapNumber(td[k]);
      if (n != null) return n;
    }
  }
  return null;
}

export function extractAmount(record) {
  if (record == null) return null;
  let n = unwrapNumber(record.amount);
  if (n != null) return n;
  n = amountFromDoc(record.rawData?.data);
  if (n != null) return n;
  n = amountFromDoc(record.rawData);
  if (n != null) return n;
  return null;
}

export function extractCurrency(record) {
  const c =
    record?.currency ||
    record?.rawData?.data?.currency_id ||
    record?.rawData?.data?.currency ||
    record?.rawData?.currency_id ||
    record?.rawData?.currency;
  return typeof c === 'string' && /^[A-Z]{3}$/i.test(c) ? c.toUpperCase() : 'ARS';
}

export function formatMoney(record) {
  const n = extractAmount(record);
  const currency = extractCurrency(record);
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency
  }).format(n);
}
