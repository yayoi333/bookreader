// トークンの暗号化（js/secret.js の暗号部分）を Node の Web Crypto で確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { newKey, encryptText, decryptText } from '../js/secret.js';

test('暗号化した値は元に戻せ、暗号文に元の文字列は含まれない', async () => {
  const key = await newKey();
  const box = await encryptText(key, 'secret-token-123');
  assert.ok(box.iv && box.data);
  assert.ok(!JSON.stringify(box).includes('secret-token-123'));
  assert.equal(await decryptText(key, box), 'secret-token-123');
});

test('鍵は取り出し不可（書き出そうとすると失敗する）', async () => {
  const key = await newKey();
  assert.equal(key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', key));
});

test('別の鍵では読めない', async () => {
  const box = await encryptText(await newKey(), 'abc');
  await assert.rejects(decryptText(await newKey(), box));
});

test('同じ値でも毎回違う暗号文になる', async () => {
  const key = await newKey();
  const a = await encryptText(key, 'same');
  const b = await encryptText(key, 'same');
  assert.notEqual(a.data, b.data);
});
