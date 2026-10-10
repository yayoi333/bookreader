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

function fakeGas({ startWithEmptyParagraph = true } = {}) {
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

  const props = { FOLDER_ID: 'main-folder' };
  const ctx = {
    DocumentApp: {
      create: createDoc,
      openById: docHandle,
      ParagraphHeading: { TITLE: 'TITLE', SUBTITLE: 'SUBTITLE', HEADING2: 'HEADING2', NORMAL: 'NORMAL' },
      GlyphType: { BULLET: 'BULLET' },
    },
    DriveApp: {
      getFileById: (id) => files.get(id),
      getFolderById: (id) => {
        if (id === 'main-folder') return folders.main;
        if (folders.audio && id === folders.audio.id) return folders.audio;
        throw new Error('not found');
      },
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
  return { run, docs, files };
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
