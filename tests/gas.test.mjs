// gas/Code.gs を、Google Apps Script の簡易な偽物の上で動かして確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');

const iter = (arr) => {
  let i = 0;
  return { hasNext: () => i < arr.length, next: () => arr[i++] };
};

function fakeGas({ startWithEmptyParagraph = true, fetchImpl = null, oldFiles = null, ttsKey = 'KEY123', geminiKey = null, geminiModel = null } = {}) {
  const docs = new Map(); // id -> { name, children }
  const files = new Map(); // id -> file
  let seq = 0;

  const makeBody = (children) => {
    const para = (text) => {
      const p = {
        text, heading: 'NORMAL',
        getText: () => p.text,
        setHeading: (h) => ((p.heading = h), p),
        setIndentStart: () => p, setIndentFirstLine: () => p, setItalic: () => p, setGlyphType: () => p,
        editAsText: () => ({ setLinkUrl: () => {} }),
        removeFromParent: () => {
          if (children.length === 1) throw new Error("Can't remove the last paragraph");
          children.splice(children.indexOf(p), 1);
        },
      };
      return p;
    };
    return {
      getParagraphs: () => [...children],
      appendParagraph: (t) => { const p = para(t); children.push(p); return p; },
      appendListItem: (t) => { const p = para(t); children.push(p); return p; },
      clear: () => { children.splice(0, children.length, para('')); },
    };
  };

  const makeFile = (id, name, mime, extra = {}) => {
    const f = {
      id, name, mime, description: '', parent: 'root', updated: ++seq,
      getId: () => f.id, getName: () => f.name, getMimeType: () => f.mime,
      getDescription: () => f.description, setDescription: (d) => ((f.description = d), f),
      getLastUpdated: () => new Date(f.updated),
      moveTo: (folder) => ((f.parent = folder.id), f),
      getUrl: () => `https://drive/${id}`,
      ...extra,
    };
    files.set(id, f);
    return f;
  };

  const folderObj = (id, name) => ({
    id,
    getId: () => id,
    getName: () => name,
    getFiles: () => iter([...files.values()].filter((f) => f.parent === id)),
    getFilesByName: (n) => iter([...files.values()].filter((f) => f.parent === id && f.name === n)),
    getFoldersByName: (n) => iter(n === '音声キャッシュ' && folders.audio ? [folders.audio] : []),
    createFolder: (n) => (folders.audio = folderObj('audio-folder', n)),
    createFile: (blob) => makeFile(`audio-${++seq}`, blob.name, 'audio/mpeg', { parent: id, getBlob: () => ({ getBytes: () => blob.bytes }) }) && null,
  });
  const folders = { main: folderObj('main-folder', 'よみあげ文庫'), audio: null };

  const createDoc = (title) => {
    const id = `doc-${++seq}`;
    const children = [];
    if (startWithEmptyParagraph) makeBody(children).appendParagraph('');
    docs.set(id, { children });
    makeFile(id, title, 'gdoc');
    return docHandle(id);
  };
  const docHandle = (id) => ({
    getBody: () => makeBody(docs.get(id).children),
    setName: (n) => (files.get(id).name = n),
    saveAndClose: () => { files.get(id).updated = ++seq; },
    getId: () => id,
    getUrl: () => `https://docs.google.com/document/d/${id}/edit`,
  });

  const props = {
    FOLDER_ID: 'main-folder', TOKEN: 'TOKEN1',
    ...(ttsKey ? { TTS_API_KEY: ttsKey } : {}),
    ...(geminiKey ? { GEMINI_API_KEY: geminiKey } : {}),
    ...(geminiModel ? { GEMINI_MODEL: geminiModel } : {}),
  };
  const fetched = [];
  const ctx = {
    DocumentApp: {
      create: createDoc,
      openById: docHandle,
      ParagraphHeading: { TITLE: 'TITLE', SUBTITLE: 'SUBTITLE', HEADING2: 'HEADING2', NORMAL: 'NORMAL' },
      GlyphType: { BULLET: 'BULLET' },
    },
    DriveApp: {
      getFileById: (id) => files.get(id),
      getFoldersByName: (n) =>
        iter(n === '自分専用の図書館' && oldFiles
          ? [{ getFiles: () => iter(oldFiles.map((o) => ({ getName: () => o.name, getBlob: () => ({ getDataAsString: () => o.text }) }))) }]
          : []),
      getFolderById: (id) => {
        if (id === 'main-folder') return folders.main;
        if (folders.audio && id === folders.audio.id) return folders.audio;
        throw new Error('not found');
      },
    },
    UrlFetchApp: {
      fetch: (url, opt) => {
        fetched.push({ url, opt });
        const r = fetchImpl ? fetchImpl(url, opt) : { code: 200, body: {} };
        return { getResponseCode: () => r.code, getContentText: () => JSON.stringify(r.body) };
      },
    },
    Logger: { log: () => {} },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => (props[k] = v) }) },
    MimeType: { GOOGLE_DOCS: 'gdoc', PLAIN_TEXT: 'text/plain' },
    Utilities: {
      base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
      base64Decode: (s) => [...Buffer.from(s, 'base64')],
      newBlob: (bytes, type, name) => ({ bytes, type, name }),
    },
  };
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  const run = (expr) => JSON.parse(JSON.stringify(vm.runInContext(expr, ctx)));
  return { run, docs, files, fetched, props };
}

const REQ = {
  title: '記事タイトル', url: 'https://x.com/a/status/1', author: '書き手',
  blocks: [{ type: 'h', text: '見出し' }, { type: 'p', text: '本文1行目\n本文2行目' }, { type: 'li', text: '項目' }],
};
const call = (fn, arg) => `${fn}(${JSON.stringify(arg)})`;

for (const startWithEmptyParagraph of [true, false]) {
  test(`Driveに保存できる（新規ドキュメントの最初の空段落が${startWithEmptyParagraph ? 'ある' : 'ない'}場合）`, () => {
    const { run, docs } = fakeGas({ startWithEmptyParagraph });
    const res = run(call('save_', REQ));
    assert.equal(res.ok, true);
    assert.deepEqual(docs.get(res.id).children.map((p) => [p.heading, p.text]), [
      ['TITLE', '記事タイトル'],
      ['SUBTITLE', '書き手 / https://x.com/a/status/1'],
      ['HEADING2', '見出し'],
      ['NORMAL', '本文1行目'],
      ['NORMAL', '本文2行目'],
      ['NORMAL', '項目'],
    ]);
  });
}

test('同じURLの記事は二重に作らず上書きする', () => {
  const { run, docs } = fakeGas();
  const first = run(call('save_', REQ));
  const second = run(call('save_', { ...REQ, title: '新しいタイトル', blocks: [{ type: 'p', text: '書き換え後' }] }));
  assert.equal(second.id, first.id);
  assert.equal(second.updated, true);
  assert.equal(docs.size, 1);
  assert.deepEqual(docs.get(first.id).children.map((p) => p.text), ['新しいタイトル', '書き手 / https://x.com/a/status/1', '書き換え後']);
  assert.equal(run("list_('')").files.length, 1);
});

test('以前に二重保存されたものは、一覧で新しい方だけ表示する', () => {
  const { run, files } = fakeGas();
  run(call('save_', REQ));
  // 古い版で作られた重複を再現（同じURLを説明に持つ別ファイル）
  const dup = run(call('save_', { ...REQ, url: 'https://x.com/b/status/2' }));
  files.get(dup.id).description = REQ.url;
  const list = run("list_('')").files;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, dup.id);
});

test('音声をDriveに保存して、別の端末から取り出せる（同じ音声は二重に保存しない）', () => {
  const { run, files } = fakeGas();
  const key = 'a'.repeat(64);
  assert.deepEqual(run(call('audioGet_', key)), { ok: true, found: false });
  const data = Buffer.from([1, 2, 3, 250]).toString('base64');
  assert.deepEqual(run(`audioPut_(${JSON.stringify(key)}, ${JSON.stringify(data)})`), { ok: true });
  assert.deepEqual(run(`audioPut_(${JSON.stringify(key)}, ${JSON.stringify(data)})`), { ok: true, existed: true });
  assert.deepEqual(run(call('audioGet_', key)), { ok: true, found: true, data });
  assert.equal([...files.values()].filter((f) => f.name === `${key}.mp3`).length, 1);
  assert.throws(() => run(call('audioGet_', '../evil')), /キー/);
});

// ---- クラウド音声の代理生成 ----

test('tts: GASがスクリプトプロパティのキーでGoogle TTSを呼び、音声を返す（キーはアプリに返さない）', () => {
  const { run, fetched } = fakeGas({ fetchImpl: () => ({ code: 200, body: { audioContent: 'QUJD' } }) });
  const res = run(`tts_('ja-JP-Chirp3-HD-Aoede', 'こんにちは。')`);
  assert.deepEqual(res, { ok: true, data: 'QUJD', chars: 6 });
  assert.match(fetched[0].url, /text:synthesize\?key=KEY123$/);
  const sent = JSON.parse(fetched[0].opt.payload);
  assert.deepEqual(sent.voice, { languageCode: 'ja-JP', name: 'ja-JP-Chirp3-HD-Aoede' });
  assert.equal(sent.input.text, 'こんにちは。');
  assert.ok(!JSON.stringify(res).includes('KEY123'));
});

test('tts: Googleの失敗は status と元のメッセージを付けて返す（「文が長すぎる」の作り直しに使う）', () => {
  const { run } = fakeGas({ fetchImpl: () => ({ code: 400, body: { error: { message: 'Sentence too long' } } }) });
  assert.deepEqual(run(`tts_('ja-JP-Neural2-B', 'あ')`), { ok: false, error: 'tts', status: 400, message: 'Sentence too long' });
});

test('tts: キー未設定・おかしな声の名前は止める', () => {
  const { run } = fakeGas({ ttsKey: null });
  assert.throws(() => run(`tts_('ja-JP-Neural2-B', 'あ')`), /TTS_API_KEY/);
  const g = fakeGas();
  assert.throws(() => g.run(`tts_('../../x', 'あ')`), /声の名前/);
});

test('voices: 日本語の声の一覧を返す', () => {
  const { run, fetched } = fakeGas({ fetchImpl: () => ({ code: 200, body: { voices: [{ name: 'ja-JP-Neural2-B' }] } }) });
  assert.deepEqual(run('voices_()'), { ok: true, voices: [{ name: 'ja-JP-Neural2-B' }] });
  assert.match(fetched[0].url, /voices\?languageCode=ja-JP&key=KEY123$/);
});

// ---- 旧版「自分専用の図書館」からの引っ越し ----

const oldJson = (o) => ({ name: `${o.title}.json`, text: JSON.stringify(o) });
const OLD = [
  oldJson({
    title: '旧記事A', author: 'Aさん', sourceUrl: 'https://x.com/a/status/10', savedAt: '2026-07-01T00:00:00Z',
    blocks: [
      { type: 'image', src: 'https://img', alt: '画像' },
      { type: 'heading', level: 1, text: '見出しA' },
      { type: 'paragraph', text: '本文A' },
      { type: 'list', ordered: false, items: ['項目1', '項目2'] },
      { type: 'quote', text: '引用A' },
      { type: 'video', src: 'v', poster: 'p', sourceUrl: 's', alt: '動画' },
    ],
  }),
  // 同じ記事の古い保存（新しい方だけ移す）
  oldJson({ title: '旧記事A（古い）', author: 'Aさん', sourceUrl: 'https://x.com/a/status/10', savedAt: '2026-06-01T00:00:00Z', blocks: [{ type: 'paragraph', text: '古い本文' }] }),
  oldJson({ title: '旧記事B', author: '', sourceUrl: 'https://note.com/b', savedAt: '2026-07-02T00:00:00Z', blocks: [{ type: 'paragraph', text: '本文B' }] }),
  { name: '旧記事A.md', text: '# これはJSONではない' },
];

test('旧版の引っ越し: JSONだけを読み、重複は新しい方、画像・動画は除いて新版の形で保存する', () => {
  const { run, docs } = fakeGas({ oldFiles: OLD });
  const res = run('importOldLibrary()');
  assert.deepEqual(res, { found: 3, saved: 2, skipped: 0 });
  const saved = [...docs.values()].map((d) => d.children.map((p) => [p.heading, p.text]).filter(([, t]) => t));
  assert.deepEqual(saved.find((d) => d[0][1] === '旧記事A'), [
    ['TITLE', '旧記事A'],
    ['SUBTITLE', 'Aさん / https://x.com/a/status/10'],
    ['HEADING2', '見出しA'],
    ['NORMAL', '本文A'],
    ['NORMAL', '項目1'],
    ['NORMAL', '項目2'],
    ['NORMAL', '引用A'],
  ]);
  assert.ok(saved.some((d) => d[0][1] === '旧記事B'));
});

test('旧版の引っ越し: 2回実行しても同じ記事は増えない', () => {
  const { run, docs } = fakeGas({ oldFiles: OLD });
  run('importOldLibrary()');
  run('importOldLibrary()');
  assert.equal(docs.size, 2);
});

test('旧版の引っ越し: 旧フォルダが無ければ分かるエラーにする', () => {
  const { run } = fakeGas();
  assert.throws(() => run('importOldLibrary()'), /自分専用の図書館/);
});

// ---- AI要約（Gemini） ----

const SUMMARY = {
  tldr: '結論の一文です。',
  points: ['要点1', '要点2', '要点3'],
  terms: [{ word: 'GAS', note: 'Googleのスクリプト' }],
  verdict: { level: '高', reason: '手順が多いため' },
};
const gemini = (obj, code = 200) => () => ({ code, body: obj });
const geminiText = (text) => gemini({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
const BLOCKS = [{ type: 'h', text: '見出し' }, { type: 'p', text: '本文です。' }, { type: 'li', text: '項目' }];
const summarizeExpr = (blocks = BLOCKS) => `summarize_('記事タイトル', ${JSON.stringify(blocks)})`;

test('要約: スクリプトプロパティのキーとモデルでGeminiを呼び、要約を返す', () => {
  const { run, fetched } = fakeGas({ geminiKey: 'GKEY', fetchImpl: geminiText(JSON.stringify(SUMMARY)) });
  const res = run(summarizeExpr());
  assert.equal(res.ok, true);
  assert.deepEqual({ ...res.summary, at: 0 }, { ...SUMMARY, model: 'gemini-3.5-flash-lite', truncated: false, at: 0 });
  assert.match(fetched[0].url, /models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(fetched[0].opt.headers['x-goog-api-key'], 'GKEY');
  assert.ok(!fetched[0].url.includes('GKEY'), 'キーをURLに入れない');
  const sent = JSON.parse(fetched[0].opt.payload);
  assert.equal(sent.generationConfig.responseMimeType, 'application/json');
  assert.ok(sent.generationConfig.responseSchema);
  const prompt = sent.contents[0].parts[0].text;
  assert.match(prompt, /タイトル: 記事タイトル/);
  assert.match(prompt, /■ 見出し\n本文です。\n・項目/);
  assert.ok(!JSON.stringify(res).includes('GKEY'));
});

test('要約: GEMINI_MODEL を設定すればそのモデルを使う', () => {
  const { run, fetched } = fakeGas({ geminiKey: 'GKEY', geminiModel: 'gemini-3.8-flash', fetchImpl: geminiText(JSON.stringify(SUMMARY)) });
  assert.equal(run(summarizeExpr()).summary.model, 'gemini-3.8-flash');
  assert.match(fetched[0].url, /models\/gemini-3\.8-flash:generateContent$/);
});

test('要約: 型指定を断られたら、型指定なしで1回だけ再試行する。```json 囲みも読める', () => {
  let n = 0;
  const { run, fetched } = fakeGas({
    geminiKey: 'GKEY',
    fetchImpl: () => (++n === 1
      ? { code: 400, body: { error: { message: 'responseSchema is not supported for this model' } } }
      : { code: 200, body: { candidates: [{ content: { parts: [{ text: '```json\n' + JSON.stringify(SUMMARY) + '\n```' }] } }] } }),
  });
  const res = run(summarizeExpr());
  assert.equal(res.ok, true);
  assert.equal(fetched.length, 2);
  assert.ok(!JSON.parse(fetched[1].opt.payload).generationConfig.responseSchema);
});

test('要約: 無料枠切れ(429)は summary_quota として分かる', () => {
  const { run } = fakeGas({ geminiKey: 'GKEY', fetchImpl: gemini({ error: { message: 'quota' } }, 429) });
  const res = run(summarizeExpr());
  assert.equal(res.ok, false);
  assert.equal(res.error, 'summary_quota');
  assert.match(res.message, /無料枠/);
});

test('要約: キー未設定・本文なし・形式崩れは例外でなくエラーを返す（記事の保存は止めない）', () => {
  assert.match(fakeGas().run(summarizeExpr()).error, /GEMINI_API_KEY/);
  const g = fakeGas({ geminiKey: 'GKEY', fetchImpl: geminiText('ごめんなさい、要約できません') });
  assert.match(g.run(summarizeExpr([])).error, /本文がありません/);
  assert.match(g.run(summarizeExpr()).error, /形式/);
  const empty = fakeGas({ geminiKey: 'GKEY', fetchImpl: gemini({ candidates: [{ finishReason: 'SAFETY' }] }) });
  assert.match(empty.run(summarizeExpr()).error, /SAFETY/);
});

test('要約: 欠けた・余計な項目は整える（評価が想定外なら「中」）', () => {
  const messy = { tldr: ' 結論 ', points: ['a', '', 'b'], terms: [{ word: 'x' }, { word: 'y', note: 'z' }], verdict: { level: 'すごく高い' } };
  const { run } = fakeGas({ geminiKey: 'GKEY', fetchImpl: geminiText(JSON.stringify(messy)) });
  const s = run(summarizeExpr()).summary;
  assert.equal(s.tldr, '結論');
  assert.deepEqual(s.points, ['a', 'b']);
  assert.deepEqual(s.terms, [{ word: 'y', note: 'z' }]);
  assert.deepEqual(s.verdict, { level: '中', reason: '' });
});

test('要約: 長すぎる記事は先頭だけを渡し、truncated を付ける', () => {
  const { run, fetched } = fakeGas({ geminiKey: 'GKEY', fetchImpl: geminiText(JSON.stringify(SUMMARY)) });
  const res = run(summarizeExpr([{ type: 'p', text: 'あ'.repeat(70000) }]));
  assert.equal(res.summary.truncated, true);
  const prompt = JSON.parse(fetched[0].opt.payload).contents[0].parts[0].text;
  assert.ok(prompt.length < 62000);
  assert.match(prompt, /先頭部分だけ/);
});

test('doPost: summarize 操作が使える（トークン必須）', () => {
  const { run } = fakeGas({ geminiKey: 'GKEY', fetchImpl: geminiText(JSON.stringify(SUMMARY)) });
  const post = (body) => `JSON.parse(doPost({ postData: { contents: ${JSON.stringify(JSON.stringify(body))} } }).text)`;
  assert.equal(run(post({ token: 'nope', action: 'summarize', title: 't', blocks: BLOCKS })).error, 'unauthorized');
  const ok = run(post({ token: 'TOKEN1', action: 'summarize', title: 't', blocks: BLOCKS }));
  assert.equal(ok.ok, true);
  assert.equal(ok.summary.tldr, SUMMARY.tldr);
});
