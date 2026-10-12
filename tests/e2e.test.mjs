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
    // normalize は Windows だと区切りを \ にするので、両方を見る
    const file = join(ROOT, /[/\\]$/.test(path) ? path + 'index.html' : path);
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
  // 自分の GAS（Drive連携・クラウド音声の代理生成）の偽物。Google TTS はアプリから直接呼ばれない
  const gasCalls = [];
  const summarizeCalls = [];
  const failSummary = { on: true };
  const audioStore = new Map();
  const directTts = [];
  await context.route('https://texttospeech.googleapis.com/**', (route) => {
    directTts.push(route.request().url());
    return route.abort();
  });
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
    if (body.action === 'voices') {
      return reply({ ok: true, voices: [
        { name: 'ja-JP-Wavenet-B', ssmlGender: 'FEMALE', languageCodes: ['ja-JP'] },
        { name: 'ja-JP-Chirp3-HD-Aoede', ssmlGender: 'FEMALE', languageCodes: ['ja-JP'] },
      ] });
    }
    if (body.action === 'summarize') {
      summarizeCalls.push(body);
      if (String(body.title).includes('要約失敗') && failSummary.on) return reply({ ok: false, error: 'AI要約に失敗しました（500）：テスト' });
      return reply({ ok: true, summary: {
        tldr: `「${body.title}」の結論です。`,
        points: ['一つ目の要点', '二つ目の要点', '三つ目の要点'],
        terms: [{ word: 'テスト用語', note: 'テストのための言葉' }],
        verdict: { level: '高', reason: '具体例が多いため' },
        model: 'gemini-test', truncated: false, at: 1760000000000,
      } });
    }
    if (body.action === 'tts') {
      ttsRequests.push({ voice: body.voice, input: { text: body.text } });
      // Google の「文が長すぎる」を再現（GAS は status と元のメッセージをそのまま返す）
      const t = body.text;
      if ((t.includes('表の行') && t.length > 40) || t.includes('絶対に読めない')) {
        return reply({ ok: false, error: 'tts', status: 400, message: 'This request contains sentences that are too long. Sentence starting with: "表の行" is too long.' });
      }
      return reply({ ok: true, data: wavBase64(), chars: t.length });
    }
    return reply({ ok: false, error: 'unknown' });
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

    await t.test('以前の版が平文で保存したトークン・APIキーは、起動時に暗号化／削除される', async () => {
      await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('yomiage.settings.v1') || '{}');
        localStorage.setItem('yomiage.settings.v1', JSON.stringify({
          ...s, gasUrl: 'https://script.google.com/macros/s/TEST/exec', gasToken: 'secret', cloudKey: 'AIza-old-key',
        }));
      });
      await page.goto(base + '#/settings');
      await page.reload();
      await page.waitForFunction(() => /APIキーを消しました/.test(document.querySelector('#toast').textContent), null, { timeout: 5000 });
      const raw = await page.evaluate(() => localStorage.getItem('yomiage.settings.v1'));
      assert.ok(!raw.includes('secret') && !raw.includes('AIza-old-key'), raw);
      assert.ok(JSON.parse(raw).gasTokenBox?.data);
      // 入力欄に値を戻さない
      await page.waitForSelector('#gas-token');
      assert.equal(await page.inputValue('#gas-token'), '');
      // 暗号化したトークンで GAS に繋がる
      await page.click('#gas-test');
      await page.waitForFunction(() => /接続OK/.test(document.querySelector('#toast').textContent));
    });

    await t.test('クラウド音声：声の一覧を取得し、音声ファイルで最後まで再生する', async () => {
      await page.goto(base + '#/settings');
      await page.waitForSelector('#cloud-voices');
      assert.equal(await page.$('#cloud-key'), null, 'APIキーの入力欄は無い');
      await page.check('input[name=engine][value=cloud]');
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
      assert.equal(req.voice, 'ja-JP-Chirp3-HD-Aoede');
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

    await t.test('AI要約：取り込むと自動で要約され、記事画面と本棚に出る（本文の読み上げには混ざらない）', async () => {
      await page.goto(base + '#/');
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', '要約テスト記事\n\n本文の一文目です。本文の二文目です。');
      await page.click('#import-btn');
      await page.waitForSelector('#summary-box .tldr', { timeout: 5000 });
      assert.equal(await page.textContent('#summary-box .tldr'), '「要約テスト記事」の結論です。');
      assert.deepEqual(await page.$$eval('#summary-box li', (els) => els.map((e) => e.textContent)), ['一つ目の要点', '二つ目の要点', '三つ目の要点']);
      assert.match(await page.textContent('#summary-box'), /テスト用語/);
      assert.match(await page.textContent('#summary-box .verdict'), /高/);
      const call = summarizeCalls.at(-1);
      assert.equal(call.title, '要約テスト記事');
      assert.deepEqual(call.blocks, [{ type: 'p', text: '要約テスト記事' }, { type: 'p', text: '本文の一文目です。本文の二文目です。' }]);
      // 本文の読み上げ対象（.seg）は本文だけ
      const segs = await page.$$eval('.seg', (els) => els.map((e) => e.textContent));
      assert.ok(!segs.some((t) => t.includes('要点')), JSON.stringify(segs));
      // 本棚にも1行要約
      await page.goto(base + '#/');
      await page.waitForSelector('.doc-summary');
      const lines = await page.$$eval('.doc-summary', (els) => els.map((e) => e.textContent));
      assert.ok(lines.some((t) => t.includes('「要約テスト記事」の結論です。')), JSON.stringify(lines));
      // 開き直しても要約は端末に残り、もう一度は頼まない
      const before = summarizeCalls.length;
      await page.click('text=要約テスト記事');
      await page.waitForSelector('#summary-box .tldr');
      assert.equal(summarizeCalls.length, before);
    });

    await t.test('AI要約：失敗しても記事は残り、「もう一度要約する」で作り直せる', async () => {
      await page.goto(base + '#/');
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', '要約失敗する記事\n\nこの記事は最初の要約に失敗します。');
      await page.click('#import-btn');
      await page.waitForSelector('#summary-btn', { timeout: 5000 });
      assert.match(await page.textContent('#summary-box'), /要約できませんでした/);
      assert.equal(await page.textContent('#summary-btn'), 'もう一度要約する');
      assert.equal(await page.textContent('.reader h1'), '要約失敗する記事');
      assert.ok((await page.$$('.seg')).length > 0, '本文は読める');
      failSummary.on = false;
      await page.click('#summary-btn');
      await page.waitForSelector('#summary-box .tldr', { timeout: 5000 });
      assert.equal(await page.textContent('#summary-box .tldr'), '「要約失敗する記事」の結論です。');
      // 作り直すボタンでもう一度頼める
      const before = summarizeCalls.length;
      await page.click('#summary-btn');
      await page.waitForFunction((n) => document.querySelector('#summary-box .tldr') && true, before);
      await page.waitForTimeout(300);
      assert.equal(summarizeCalls.length, before + 1);
    });

    await t.test('要約を聴く：読み上げる内容が本文から要約に変わり、▶で本文に戻せる', async () => {
      await page.goto(base + '#/');
      await page.waitForSelector('.doc-title');
      await page.click('text=要約テスト記事');
      await page.waitForSelector('#summary-play');
      const before = ttsRequests.length;
      await page.click('#summary-play');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 15000 });
      assert.equal(await page.textContent('#p-title'), '要約テスト記事（要約）');
      const spoken = ttsRequests.slice(before).map((r) => r.input.text).join('');
      assert.match(spoken, /「要約テスト記事」の結論です/);
      assert.match(spoken, /一つ目の要点/);
      assert.match(spoken, /テスト用語/);
      assert.match(spoken, /全文も読む価値は、高です/);
      assert.doesNotMatch(spoken, /本文の一文目/);
      // 要約を聴いている間、本文のハイライトは動かない
      assert.equal(await page.$('.reader-body .seg.current'), null);
      // ▶（本文）を押すと本文に戻る
      const before2 = ttsRequests.length;
      await page.click('#read-btn');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 15000 });
      assert.equal(await page.textContent('#p-title'), '要約テスト記事');
      assert.match(ttsRequests.slice(before2).map((r) => r.input.text).join(''), /本文の一文目/);
    });

    await t.test('まとめて聴く：未読の要約を新しい順に、タイトルを読んでから続けて再生する', async () => {
      // 未読の要約を3本以上にする（ここまでの記事の多くは本文を聴き終えている）
      await page.goto(base + '#/');
      await page.waitForSelector('#import-input');
      await page.fill('#import-input', 'まとめ用の記事\n\nまとめて聴くための記事です。');
      await page.click('#import-btn');
      await page.waitForSelector('#summary-box .tldr', { timeout: 5000 });
      await page.goto(base + '#/');
      await page.waitForSelector('#queue-play');
      const label = await page.textContent('#queue-play');
      const n = Number(label.match(/（(\d+)本）/)[1]);
      assert.ok(n >= 3, label);
      // 未読＝本文を聴き終えていない記事。直前に本文を聴き終えた「要約テスト記事」は入らない
      const titles = await page.evaluate(async () => {
        const db = await new Promise((r) => { const q = indexedDB.open('yomiage'); q.onsuccess = () => r(q.result); });
        const all = await new Promise((r) => { const q = db.transaction('docs').objectStore('docs').getAll(); q.onsuccess = () => r(q.result); });
        return all.filter((d) => d.summary).sort((a, b) => b.updatedAt - a.updatedAt).map((d) => d.title);
      });
      const before = ttsRequests.length;
      await page.click('#queue-play');
      await page.waitForFunction(() => document.querySelector('#p-pos').textContent === '読了', null, { timeout: 30000 });
      assert.match(await page.textContent('#p-title'), new RegExp(`未読の要約（${n}本）`));
      const spoken = ttsRequests.slice(before).map((r) => r.input.text).join('');
      for (let i = 1; i <= n; i++) assert.match(spoken, new RegExp(`${i}本目`));
      assert.doesNotMatch(spoken, /要約テスト記事」の結論/, '聴き終えた記事は入らない');
      assert.match(spoken, /要約失敗する記事/);
      assert.doesNotMatch(spoken, /テスト用語/, 'まとめて聴くでは用語を省く');
      // 1本目が一番新しい記事
      const unreadTitles = titles.filter((t) => t !== '要約テスト記事');
      assert.ok(spoken.indexOf(`1本目。${unreadTitles[0]}`) >= 0, `${unreadTitles[0]} / ${spoken.slice(0, 80)}`);
    });

    const statusesInDb = () => page.evaluate(async () => {
      const db = await new Promise((r) => { const q = indexedDB.open('yomiage'); q.onsuccess = () => r(q.result); });
      const all = await new Promise((r) => { const q = db.transaction('docs').objectStore('docs').getAll(); q.onsuccess = () => r(q.result); });
      return Object.fromEntries(all.map((d) => [d.title, d.status || null]));
    });
    const countOf = async (f) => Number(await page.textContent(`[data-filter="${f}"] .count`));

    await t.test('状態：本棚を未読／あとで／読了で絞り込める。ボタンで状態を変えられる', async () => {
      for (const title of ['キー操作の記事1', 'キー操作の記事2', 'キー操作の記事3']) {
        await page.goto(base + '#/');
        await page.waitForSelector('#import-input');
        await page.fill('#import-input', `${title}\n\n${title}の本文です。`);
        await page.click('#import-btn');
        await page.waitForSelector('.reader h1');
      }
      await page.goto(base + '#/');
      await page.waitForSelector('.filters');
      const total = await countOf('all');
      assert.equal((await countOf('unread')) + (await countOf('later')) + (await countOf('done')), total);
      // 本文を聴き終えた記事は自動で読了
      assert.equal((await statusesInDb())['要約テスト記事'], 'done');
      // 「あとで」ボタン
      await page.click('[data-doc] [data-status="later"]');
      await page.waitForSelector('[data-doc] [data-status="later"][aria-pressed="true"]');
      await page.click('[data-filter="later"]');
      await page.waitForSelector('.filter.active[data-filter="later"]');
      const laterItems = await page.$$eval('.doc-list li', (els) => els.map((e) => e.dataset.statusNow));
      assert.deepEqual(laterItems, ['later']);
      // 読了だけ
      await page.click('[data-filter="done"]');
      await page.waitForSelector('.filter.active[data-filter="done"]');
      const doneItems = await page.$$eval('.doc-list li', (els) => els.map((e) => e.dataset.statusNow));
      assert.ok(doneItems.length >= 1 && doneItems.every((x) => x === 'done'), JSON.stringify(doneItems));
      // 絞り込みは開き直しても覚えている
      await page.reload();
      await page.waitForSelector('.filter.active[data-filter="done"]');
    });

    await t.test('キー操作：本棚で J と E だけを押して、未読3件を読了にできる', async () => {
      await page.click('[data-filter="unread"]');
      await page.waitForSelector('.filter.active[data-filter="unread"]');
      const before = await countOf('unread');
      const firstThree = await page.$$eval('.doc-list li .doc-title', (els) => els.slice(0, 3).map((e) => e.textContent));
      await page.click('.section-title'); // 入力欄から外す
      await page.keyboard.press('j');
      await page.waitForSelector('.doc-list li.kb-selected');
      for (let i = 0; i < 3; i++) {
        await page.keyboard.press('e');
        await page.waitForFunction((n) => Number(document.querySelector('[data-filter="unread"] .count').textContent) === n, before - i - 1);
      }
      const st = await statusesInDb();
      for (const title of firstThree) assert.equal(st[title], 'done', title);
      assert.equal(await countOf('unread'), before - 3);
      // まとめて聴くは未読だけ（読了にした記事は入らない）
      const label = (await page.textContent('#queue-play').catch(() => '')) || '';
      const n = Number((label.match(/（(\d+)本）/) || [0, 0])[1]);
      assert.ok(n <= before - 3, label);
    });

    await t.test('キー操作：記事画面で E を押すと読了になり、次の記事へ。K で前、Esc で本棚', async () => {
      await page.click('[data-filter="all"]');
      await page.waitForSelector('.filter.active[data-filter="all"]');
      const titles = await page.$$eval('.doc-list li .doc-title', (els) => els.map((e) => e.textContent));
      await page.click('.doc-list li .doc-item');
      await page.waitForSelector('.reader h1');
      assert.equal(await page.textContent('.reader h1'), titles[0]);
      await page.keyboard.press('j');
      await page.waitForFunction((t) => document.querySelector('.reader h1')?.textContent === t, titles[1]);
      await page.keyboard.press('k');
      await page.waitForFunction((t) => document.querySelector('.reader h1')?.textContent === t, titles[0]);
      // 前のテストで読了／あとでになっていたら、ボタンで未読に戻してから試す
      for (const btn of ['#status-done', '#status-later']) {
        if ((await page.getAttribute(btn, 'aria-pressed')) === 'true') {
          await page.click(btn);
          await page.waitForSelector(`${btn}[aria-pressed="false"]`);
        }
      }
      await page.click('.reader h1'); // ボタンからフォーカスを外す
      assert.equal((await statusesInDb())[titles[0]], 'unread');
      await page.keyboard.press('e');
      await page.waitForFunction((t) => document.querySelector('.reader h1')?.textContent === t, titles[1]);
      assert.equal((await statusesInDb())[titles[0]], 'done');
      await page.keyboard.press('Escape');
      await page.waitForSelector('.filters');
      // 入力欄で文字を打っても反応しない
      await page.click('#import-input');
      await page.keyboard.type('je');
      assert.equal(await page.inputValue('#import-input'), 'je');
      await page.fill('#import-input', '');
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

    await t.test('日付：元記事の公開日が取れればそれを本棚に出し、無ければ取り込んだ日', async () => {
      const result = await page.evaluate(async (b) => {
        const { docFromPageHtml } = await import(b + 'js/extract.js');
        const dated = await (await fetch(b + 'tests/fixtures/dated-article.html')).text();
        const undated = await (await fetch(b + 'tests/fixtures/article.html')).text();
        return {
          dated: docFromPageHtml(dated, 'https://example.com/dated').publishedAt,
          undated: docFromPageHtml(undated, 'https://example.com/undated').publishedAt,
        };
      }, base);
      assert.equal(result.dated, Date.parse('2026-08-03T14:32:06.000+09:00'), '検索エンジン向け情報欄の日付（time要素より優先）');
      assert.equal(result.undated, null);
      // ブックマークレットで日付のある記事を取り込み、本棚に元記事の日付が出る
      await page.goto(base + '#/help');
      await page.waitForSelector('#bm-code');
      const code = decodeURIComponent((await page.textContent('#bm-code')).replace(/^javascript:/, ''));
      const article = await context.newPage();
      await article.goto(base + 'tests/fixtures/dated-article.html');
      const [popup] = await Promise.all([context.waitForEvent('page'), article.evaluate(code)]);
      await popup.waitForSelector('.reader h1', { timeout: 10000 });
      assert.match(await popup.textContent('.reader-head .doc-meta'), /2026\/8\/3/);
      await popup.goto(base + '#/');
      await popup.click('[data-filter="all"]');
      await popup.waitForSelector('.filter.active[data-filter="all"]');
      const metas = await popup.$$eval('.doc-list li', (els) => els.map((e) => [e.querySelector('.doc-title').textContent, e.querySelector('.doc-meta').textContent]));
      const dated = metas.find(([t]) => t === '日付のある記事');
      assert.ok(dated && /2026\/8\/3/.test(dated[1]), JSON.stringify(metas));
      // 日付の無いメモは取り込んだ日（今日）
      const today = await popup.evaluate(() => { const d = new Date(); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; });
      const memo = metas.find(([t]) => t === 'まとめ用の記事');
      assert.ok(memo && memo[1].includes(today), JSON.stringify(memo) + ' / ' + today);
      // Xの記事は投稿日時
      const x = metas.find(([t]) => t === 'Xの長文記事テスト');
      const xDate = await popup.evaluate(() => { const d = new Date(1760000000 * 1000); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; });
      assert.ok(x && x[1].includes(xDate), JSON.stringify(x) + ' / ' + xDate);
      await popup.close();
      await article.close();
    });

    assert.deepEqual(directTts, [], 'アプリから Google TTS を直接呼んでいない');
    assert.ok(gasCalls.every((c) => !('key' in c && /^AIza/.test(c.key))));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
