// ブラウザ（Chromium）で実際に画面を動かす結合テスト。
// X の API・Google TTS・端末の音声エンジンは偽物に差し替えて、取り込み〜読み上げ〜進捗保存の流れを確かめる。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  chromium = null;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

function serve() {
  const server = http.createServer(async (req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path.endsWith('/') ? path + 'index.html' : path);
    try {
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// 0.3秒の無音WAV（クラウド音声の偽レスポンス）
function wavBase64(seconds = 0.3, rate = 8000) {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  return b.toString('base64');
}

const FX_ARTICLE = {
  code: 200,
  message: 'OK',
  tweet: {
    url: 'https://x.com/writer/status/111',
    text: 'https://t.co/abc',
    created_timestamp: 1760000000,
    author: { name: '書き手', screen_name: 'writer' },
    article: {
      title: 'Xの長文記事テスト',
      preview_text: '',
      content: {
        blocks: [
          { key: '1', type: 'header-one', text: 'はじめに', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: '2', type: 'unstyled', text: '一つ目の文です。詳しくは https://example.com を見てください🙏', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: '3', type: 'atomic', text: ' ', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: '4', type: 'unordered-list-item', text: '箇条書きの項目', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: '5', type: 'unstyled', text: '最後の文です。', data: {}, entityRanges: [], inlineStyleRanges: [] },
        ],
        entityMap: [],
      },
    },
  },
};

// 端末の音声エンジンの偽物（話した内容と速度を記録し、短時間で「読み終わり」を返す）
const FAKE_SPEECH = () => {
  window.__spoken = [];
  class FakeUtterance {
    constructor(text) { this.text = text; this.rate = 1; this.lang = ''; this.voice = null; }
  }
  const synth = {
    speaking: false, pending: false, _cur: null, _timer: null,
    getVoices: () => [{ name: 'Google 日本語', lang: 'ja-JP', localService: false }],
    addEventListener() {}, removeEventListener() {},
    speak(u) {
      this.speaking = true; this._cur = u;
      window.__spoken.push({ text: u.text, rate: u.rate });
      this._timer = setTimeout(() => { this.speaking = false; this._cur = null; u.onend && u.onend({}); }, 40);
    },
    cancel() {
      clearTimeout(this._timer);
      const u = this._cur; this._cur = null; this.speaking = false;
      if (u && u.onerror) u.onerror({ error: 'interrupted' });
    },
    pause() {}, resume() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
};

test('ブラウザでの取り込み・読み上げ・進捗・クラウド音声・ブックマークレット', { skip: !chromium && 'playwright が無いので省略' }, async (t) => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const context = await browser.newContext();
  await context.addInitScript(FAKE_SPEECH);
  const ttsRequests = [];
  await context.route('https://api.fxtwitter.com/**', (route) =>
    route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(FX_ARTICLE) }),
  );
  await context.route('https://texttospeech.googleapis.com/**', async (route) => {
    const req = route.request();
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (req.url().includes('/voices')) {
      return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ voices: [
        { name: 'ja-JP-Wavenet-B', ssmlGender: 'FEMALE', languageCodes: ['ja-JP'] },
        { name: 'ja-JP-Chirp3-HD-Aoede', ssmlGender: 'FEMALE', languageCodes: ['ja-JP'] },
      ] }) });
    }
    const body = JSON.parse(req.postData());
    ttsRequests.push(body);
    // Google の「文が長すぎる」を再現：「表の行」を含む長いリクエストは断る。「絶対に読めない」は常に断る
    const t = body.input.text;
    if ((t.includes('表の行') && t.length > 40) || t.includes('絶対に読めない')) {
      return route.fulfill({ status: 400, contentType: 'application/json', headers, body: JSON.stringify({ error: { code: 400, message: 'This request contains sentences that are too long. Sentence starting with: "表の行" is too long.' } }) });
    }
    return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ audioContent: wavBase64() }) });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await t.test('XのURLを貼って取り込むと、記事本文だけが表示される', async () => {
      await page.goto(base);
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', 'https://x.com/writer/status/111?s=20');
      await page.click('#import-btn');
      await page.waitForSelector('.reader h1');
      assert.equal(await page.textContent('.reader h1'), 'Xの長文記事テスト');
      const segs = await page.$$eval('.seg', (els) => els.map((e) => e.textContent));
      assert.deepEqual(segs, ['はじめに', '一つ目の文です。', '詳しくは https://example.com を見てください🙏', '箇条書きの項目', '最後の文です。']);
      assert.equal(await page.isVisible('#player'), true);
    });

    await t.test('▶で最初から最後まで読み、URL・絵文字は読まない', async () => {
      await page.click('#read-btn');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了');
      const spoken = await page.evaluate(() => window.__spoken.map((s) => s.text));
      assert.deepEqual(spoken, ['はじめに', '一つ目の文です。', '詳しくは を見てください', '箇条書きの項目', '最後の文です。']);
    });

    await t.test('文をタップするとそこから読み、速度変更が反映される', async () => {
      await page.evaluate(() => (window.__spoken = []));
      await page.selectOption('#p-rate', '1.5');
      await page.click('.seg[data-i="3"]');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了');
      const spoken = await page.evaluate(() => window.__spoken);
      assert.deepEqual(spoken.map((s) => s.text), ['箇条書きの項目', '最後の文です。']);
      assert.ok(spoken.every((s) => s.rate === 1.5));
    });

    await t.test('途中で止めると、開き直しても続きから', async () => {
      await page.evaluate(() => {
        // 読み終わりを遅くして、途中で一時停止できるようにする
        const s = window.speechSynthesis;
        const orig = s.speak.bind(s);
        s.speak = (u) => { orig(u); clearTimeout(s._timer); s._timer = setTimeout(() => { s.speaking = false; s._cur = null; u.onend && u.onend({}); }, 1500); };
      });
      await page.click('.seg[data-i="1"]');
      await page.waitForSelector('.seg[data-i="2"].current', { timeout: 5000 });
      await page.click('#p-play'); // 一時停止（3文目を読んでいる途中）
      await page.waitForTimeout(300);
      await page.reload();
      await page.waitForSelector('#read-btn');
      assert.match(await page.textContent('#read-btn'), /続きから/);
      assert.equal(await page.textContent('#p-pos'), '3 / 5 文');
      assert.ok(await page.$('.seg[data-i="2"].current'));
    });

    await t.test('テキストを貼って取り込める・本棚に並ぶ', async () => {
      await page.goto(base + '#/');
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', 'メモのタイトル\n\n今日は良い天気でした。散歩に行きました。');
      await page.click('#import-btn');
      await page.waitForSelector('.reader h1');
      assert.equal(await page.textContent('.reader h1'), 'メモのタイトル');
      await page.goto(base + '#/');
      await page.waitForSelector('.doc-list');
      const titles = await page.$$eval('.doc-title', (els) => els.map((e) => e.textContent));
      assert.equal(titles.length, 2);
      assert.ok(titles.includes('Xの長文記事テスト'));
    });

    await t.test('共有（?url=）で開くと取り込み済みの同じ記事を開く（重複しない）', async () => {
      await page.goto(base + '?url=' + encodeURIComponent('https://x.com/writer/status/111'));
      await page.waitForSelector('.reader h1');
      assert.equal(await page.textContent('.reader h1'), 'Xの長文記事テスト');
      assert.ok(!page.url().includes('?url='));
      await page.goto(base + '#/');
      await page.waitForSelector('.doc-list');
      assert.equal((await page.$$('.doc-title')).length, 2);
    });

    await t.test('クラウド音声：声の一覧を取得し、音声ファイルで最後まで再生する', async () => {
      await page.goto(base + '#/settings');
      await page.waitForSelector('#cloud-key');
      await page.check('input[name=engine][value=cloud]');
      await page.fill('#cloud-key', 'AIza-test');
      await page.click('#cloud-voices');
      await page.waitForFunction(() => document.querySelectorAll('#cloud-voice option').length === 2);
      await page.selectOption('#cloud-voice', 'ja-JP-Chirp3-HD-Aoede');
      await page.goto(base + '#/');
      await page.waitForSelector('.doc-title');
      await page.click('text=Xの長文記事テスト');
      await page.waitForSelector('#read-btn');
      await page.evaluate(() => (window.__spoken = []));
      await page.click('.seg[data-i="0"]');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 15000 });
      assert.ok(ttsRequests.length >= 1);
      const req = ttsRequests[0];
      assert.equal(req.voice.name, 'ja-JP-Chirp3-HD-Aoede');
      assert.equal(req.audioConfig.audioEncoding, 'MP3');
      assert.equal(req.input.text, 'はじめに。一つ目の文です。詳しくは を見てください。箇条書きの項目。最後の文です。');
      // 端末の声は使われていない
      assert.equal((await page.evaluate(() => window.__spoken)).length, 0);
      assert.equal(await page.textContent('#p-engine'), 'クラウド音声');
    });

    await t.test('クラウド音声：2回目は端末内の音声キャッシュを使い、APIを呼ばない', async () => {
      const before = ttsRequests.length;
      await page.click('.seg[data-i="0"]');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 15000 });
      assert.equal(ttsRequests.length, before);
    });

    await t.test('クラウド音声：長文は複数の音声ファイルに分け、つなぎ目で止まらず最後まで再生する', async () => {
      const before = ttsRequests.length;
      const long = Array.from({ length: 60 }, (_, i) => `これは長い記事の${i + 1}番目の文で、つなぎ目の確認に使います。`).join('');
      await page.goto(base + '#/');
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', `長い記事\n\n${long}`);
      await page.click('#import-btn');
      await page.waitForSelector('#read-btn');
      await page.selectOption('#p-rate', '2');
      await page.click('#read-btn');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 20000 });
      const sent = ttsRequests.slice(before);
      assert.ok(sent.length >= 2, `リクエスト数 ${sent.length}`);
      // 最初は短く（すぐ再生開始）、どれも5000バイト未満
      const bytes = sent.map((r) => Buffer.byteLength(r.input.text));
      assert.ok(bytes[0] <= 1000, `最初のチャンク ${bytes[0]}`);
      assert.ok(bytes.every((b) => b < 5000));
      // 文章は欠けずにすべて送られている
      assert.equal(sent.map((r) => r.input.text).join('').replace(/。/g, ''), ('長い記事' + long).replace(/。/g, ''));
    });

    await t.test('クラウド音声：「文が長すぎる」と断られても1文ずつ作り直し、読めない文だけ飛ばして最後まで再生する', async () => {
      const before = ttsRequests.length;
      await page.goto(base + '#/');
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', '表のある記事\n\n表の行その1です。表の行その2です。絶対に読めない文。最後の文です。');
      await page.click('#import-btn');
      await page.waitForSelector('#read-btn');
      await page.evaluate(() => {
        window.__toasts = [];
        new MutationObserver(() => window.__toasts.push(document.querySelector('#toast').textContent))
          .observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true });
      });
      await page.click('#read-btn');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 20000 });
      const toasts = await page.evaluate(() => window.__toasts);
      assert.ok(toasts.some((m) => /（1か所）を読み飛ばしました/.test(m)), JSON.stringify(toasts));
      assert.ok(!toasts.some((m) => /too long|長すぎ/.test(m)), 'エラーで止まっていない');
      const texts = ttsRequests.slice(before).map((r) => r.input.text);
      // 1回目（まとめて）→ 2回目（句点を補って）→ 1文ずつ
      assert.ok(texts.includes('表の行その1です。'));
      assert.ok(texts.includes('最後の文です。'));
    });

    await t.test('Drive連携：接続テスト・自動保存・Driveの文書を開く', async () => {
      const gasCalls = [];
      const audioStore = new Map();
      await context.route('https://script.google.com/**', async (route) => {
        const body = JSON.parse(route.request().postData() || '{}');
        gasCalls.push(body);
        const reply = (obj) => route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(obj) });
        if (body.token !== 'secret') return reply({ ok: false, error: 'unauthorized' });
        if (body.action === 'ping') return reply({ ok: true, folder: 'よみあげ文庫' });
        if (body.action === 'save') return reply({ ok: true, id: 'file-1', url: 'https://docs.google.com/document/d/file-1/edit' });
        if (body.action === 'list') return reply({ ok: true, files: [{ id: 'memo-9', name: '自分のメモ', updated: 1760000000000 }] });
        if (body.action === 'get') return reply({ ok: true, title: '自分のメモ', url: 'https://docs.google.com/document/d/memo-9/edit', blocks: [{ type: 'h', text: '買い物' }, { type: 'li', text: '牛乳' }] });
        if (body.action === 'audioPut') { audioStore.set(body.key, body.data); return reply({ ok: true }); }
        if (body.action === 'audioGet') return reply(audioStore.has(body.key) ? { ok: true, found: true, data: audioStore.get(body.key) } : { ok: true, found: false });
        return reply({ ok: false, error: 'unknown' });
      });
      await page.goto(base + '#/settings');
      await page.waitForSelector('#gas-url');
      await page.fill('#gas-url', 'https://script.google.com/macros/s/TEST/exec');
      await page.fill('#gas-token', 'wrong');
      await page.click('#gas-test');
      await page.waitForFunction(() => /トークンが違います/.test(document.querySelector('#toast').textContent));
      await page.fill('#gas-token', 'secret');
      await page.click('#gas-test');
      await page.waitForFunction(() => /接続OK/.test(document.querySelector('#toast').textContent));
      await page.check('#auto-drive');

      await page.goto(base + '#/');
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', '保存テスト\n\nDriveに保存される文章です。');
      await page.click('#import-btn');
      await page.waitForFunction(() => /Driveにも保存しました/.test(document.querySelector('#toast').textContent));
      const save = gasCalls.find((c) => c.action === 'save');
      assert.equal(save.title, '保存テスト');
      assert.deepEqual(save.blocks, [{ type: 'p', text: '保存テスト' }, { type: 'p', text: 'Driveに保存される文章です。' }]);
      await page.waitForSelector('a.btn[href*="docs.google.com"]');

      await page.goto(base + '#/drive');
      await page.waitForSelector('[data-id="memo-9"]');
      await page.click('[data-id="memo-9"]');
      await page.waitForSelector('.reader h1');
      assert.equal(await page.textContent('.reader h1'), '自分のメモ');
      assert.deepEqual(await page.$$eval('.seg', (els) => els.map((e) => e.textContent)), ['買い物', '牛乳']);
    });

    await t.test('クラウド音声をDriveで共有：別の端末（音声キャッシュ無し）でも生成し直さない', async () => {
      // この端末で作った音声を再生すると Drive に送られる
      await page.goto(base + '#/');
      await page.waitForSelector('.doc-title');
      await page.click('text=Xの長文記事テスト');
      await page.waitForSelector('#read-btn');
      await page.click('.seg[data-i="0"]');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 15000 });
      await page.waitForTimeout(500);
      const gasCallsBefore = ttsRequests.length;
      // 別の端末を再現：端末内の音声キャッシュを消す
      await page.goto(base + '#/settings');
      await page.waitForSelector('#cache-clear');
      await page.click('#cache-clear');
      await page.waitForFunction(() => /削除しました/.test(document.querySelector('#toast').textContent));
      await page.goto(base + '#/');
      await page.waitForSelector('.doc-title');
      await page.click('text=Xの長文記事テスト');
      await page.waitForSelector('#read-btn');
      await page.click('.seg[data-i="0"]');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 15000 });
      assert.equal(ttsRequests.length, gasCallsBefore, 'Google TTS を呼ばずに Drive の音声で再生する');
    });

    await t.test('ブックマークレット：Web記事から本文だけを取り込む', async () => {
      await page.goto(base + '#/help');
      await page.waitForSelector('#bm-code');
      const code = decodeURIComponent((await page.textContent('#bm-code')).replace(/^javascript:/, ''));
      const article = await context.newPage();
      await article.goto(base + 'tests/fixtures/article.html');
      const [popup] = await Promise.all([context.waitForEvent('page'), article.evaluate(code)]);
      await popup.waitForSelector('.reader h1', { timeout: 10000 });
      assert.equal(await popup.textContent('.reader h1'), 'テスト記事');
      const body = await popup.textContent('.reader-body');
      assert.match(body, /本文だけを取り出すことが大切です/);
      assert.doesNotMatch(body, /会社概要|半額セール|利用規約/);
      await popup.close();
      await article.close();
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
