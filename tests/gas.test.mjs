// gas/Code.gs の保存処理を、Google Apps Script の簡易な偽物の上で動かして確かめる
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const CODE = readFileSync(new URL('../gas/Code.gs', import.meta.url), 'utf8');

function fakeGas({ startWithEmptyParagraph }) {
  const children = [];
  const para = (text) => {
    const p = {
      text, heading: 'NORMAL',
      getText: () => p.text,
      setHeading: (h) => ((p.heading = h), p),
      setIndentStart: () => p, setIndentFirstLine: () => p, setItalic: () => p, setGlyphType: () => p,
      editAsText: () => ({ setLinkUrl: () => {} }),
      removeFromParent: () => {
        if (children.length === 1) throw new Error('Can\'t remove the last paragraph');
        children.splice(children.indexOf(p), 1);
      },
    };
    return p;
  };
  if (startWithEmptyParagraph) children.push(para(''));
  const body = {
    getParagraphs: () => [...children],
    appendParagraph: (t) => { const p = para(t); children.push(p); return p; },
    appendListItem: (t) => { const p = para(t); p.list = true; children.push(p); return p; },
  };
  const file = { moveTo: () => {}, setDescription: () => {} };
  const ctx = {
    DocumentApp: {
      create: () => ({ getBody: () => body, saveAndClose: () => {}, getId: () => 'doc-1', getUrl: () => 'https://docs.google.com/document/d/doc-1/edit' }),
      ParagraphHeading: { TITLE: 'TITLE', SUBTITLE: 'SUBTITLE', HEADING2: 'HEADING2', NORMAL: 'NORMAL' },
      GlyphType: { BULLET: 'BULLET' },
    },
    DriveApp: { getFileById: () => file },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'folder-1', setProperty: () => {} }) },
    MimeType: { GOOGLE_DOCS: 'gdoc', PLAIN_TEXT: 'text/plain' },
  };
  ctx.DriveApp.getFolderById = () => ({ getName: () => 'よみあげ文庫' });
  vm.createContext(ctx);
  vm.runInContext(CODE, ctx);
  return { ctx, children };
}

const REQ = {
  title: '記事タイトル', url: 'https://x.com/a/status/1', author: '書き手',
  blocks: [{ type: 'h', text: '見出し' }, { type: 'p', text: '本文' }, { type: 'li', text: '項目' }],
};

for (const startWithEmptyParagraph of [true, false]) {
  test(`Driveに保存できる（新規ドキュメントの最初の空段落が${startWithEmptyParagraph ? 'ある' : 'ない'}場合）`, () => {
    const { ctx, children } = fakeGas({ startWithEmptyParagraph });
    const res = vm.runInContext(`save_(${JSON.stringify(REQ)})`, ctx);
    assert.equal(res.ok, true);
    assert.equal(res.id, 'doc-1');
    assert.deepEqual(children.map((p) => [p.heading, p.text]), [
      ['TITLE', '記事タイトル'],
      ['SUBTITLE', '書き手 / https://x.com/a/status/1'],
      ['HEADING2', '見出し'],
      ['NORMAL', '本文'],
      ['NORMAL', '項目'],
    ]);
  });
}
