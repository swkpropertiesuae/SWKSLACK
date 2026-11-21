/** A per-device signing key kept in the browser's key store. The private key is non-extractable, so it cannot be copied to another phone. */
const DB = 'swk-device', STORE = 'keys', ID = 'checkin'
const open = () => new Promise<IDBDatabase>((res, rej) => { const r = indexedDB.open(DB, 1); r.onupgradeneeded = () => r.result.createObjectStore(STORE); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
const tx = <T,>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>) => new Promise<T>((res, rej) => { const q = fn(db.transaction(STORE, mode).objectStore(STORE)); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error) })
const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

async function pair(): Promise<CryptoKeyPair> {
  const db = await open()
  const have = await tx<CryptoKeyPair | undefined>(db, 'readonly', s => s.get(ID))
  if (have) return have
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  await tx(db, 'readwrite', s => s.put(kp, ID))
  return kp
}
export async function signProof(message: string) {
  if (!crypto?.subtle || !window.indexedDB) throw new Error('This browser cannot secure a device key. Use a current Chrome or Safari over https.')
  const kp = await pair()
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey)
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(message))
  return { pub: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, sig: b64u(sig) }
}
