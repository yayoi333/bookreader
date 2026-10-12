// 秘密の値（GAS のトークン）を端末内に暗号化して保存する。
// 暗号鍵は Web Crypto で「取り出し不可」として作り、IndexedDB にだけ置く。
// localStorage には暗号文しか残らず、鍵そのものはスクリプトからも書き出せない。
import { kv } from './db.js';

const KEY_NAME = 'secret-key-v1';
const enc = new TextEncoder();
const dec = new TextDecoder();

const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function newKey(subtle = crypto.subtle) {
  return subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptText(key, text, cryptoObj = crypto) {
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const data = await cryptoObj.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return { iv: toB64(iv), data: toB64(data) };
}

export async function decryptText(key, box, subtle = crypto.subtle) {
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv: fromB64(box.iv) }, key, fromB64(box.data));
  return dec.decode(plain);
}

let keyPromise;
function deviceKey() {
  if (!keyPromise) {
    keyPromise = (async () => {
      const saved = await kv.get(KEY_NAME);
      if (saved) return saved;
      const key = await newKey();
      await kv.set(KEY_NAME, key); // CryptoKey はそのまま IndexedDB に入れられる
      return key;
    })();
  }
  return keyPromise;
}

export async function sealSecret(text) {
  return encryptText(await deviceKey(), text);
}

export async function openSecret(box) {
  if (!box || !box.iv || !box.data) return '';
  try {
    return await decryptText(await deviceKey(), box);
  } catch {
    return ''; // 鍵が消えた（サイトデータ削除など）ときは未設定扱い
  }
}
