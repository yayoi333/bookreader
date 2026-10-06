import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXUrl, fxResponseToDoc, articleToBlocks } from '../js/x-article.js';

test('XのURLからポストIDを取り出す', () => {
  assert.deepEqual(parseXUrl('https://x.com/jack/status/20'), { id: '20', handle: 'jack' });
  assert.deepEqual(parseXUrl('https://twitter.com/jack/status/20?s=46&t=abc'), { id: '20', handle: 'jack' });
  assert.deepEqual(parseXUrl('https://mobile.twitter.com/jack/statuses/20'), { id: '20', handle: 'jack' });
  assert.deepEqual(parseXUrl('https://x.com/i/web/status/1234'), { id: '1234', handle: null });
  assert.deepEqual(parseXUrl('https://x.com/someone/article/987'), { id: '987', handle: 'someone' });
  assert.deepEqual(parseXUrl('https://fixupx.com/a_b/status/5'), { id: '5', handle: 'a_b' });
  assert.equal(parseXUrl('https://x.com/jack'), null);
  assert.equal(parseXUrl('https://example.com/a/status/1'), null);
  assert.equal(parseXUrl('not a url'), null);
});

const articleJson = {
  code: 200,
  message: 'OK',
  tweet: {
    url: 'https://x.com/writer/status/111',
    text: 'https://t.co/xxxx',
    created_timestamp: 1760000000,
    author: { name: '書き手', screen_name: 'writer' },
    article: {
      title: '記事のタイトル',
      preview_text: 'プレビュー',
      content: {
        blocks: [
          { key: 'a', type: 'header-one', text: '第1章', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: 'b', type: 'unstyled', text: '本文です。', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: 'c', type: 'atomic', text: ' ', data: {}, entityRanges: [{ key: 0, offset: 0, length: 1 }], inlineStyleRanges: [] },
          { key: 'd', type: 'unordered-list-item', text: '項目', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: 'e', type: 'blockquote', text: '引用文', data: {}, entityRanges: [], inlineStyleRanges: [] },
          { key: 'f', type: 'unstyled', text: '   ', data: {}, entityRanges: [], inlineStyleRanges: [] },
        ],
        entityMap: [],
      },
    },
  },
};

test('X記事を見出し・本文・リスト・引用に変換し、画像ブロックは読まない', () => {
  const doc = fxResponseToDoc(articleJson, 'https://x.com/writer/article/111');
  assert.equal(doc.title, '記事のタイトル');
  assert.equal(doc.author, '書き手 (@writer)');
  assert.equal(doc.source, 'x');
  assert.equal(doc.url, 'https://x.com/writer/status/111');
  assert.equal(doc.publishedAt, 1760000000000);
  assert.deepEqual(doc.blocks, [
    { type: 'h', text: '第1章' },
    { type: 'p', text: '本文です。' },
    { type: 'li', text: '項目' },
    { type: 'quote', text: '引用文' },
  ]);
});

test('本文が空の記事はプレビュー文を使う', () => {
  assert.deepEqual(articleToBlocks({ content: { blocks: [] } }), []);
  const json = structuredClone(articleJson);
  json.tweet.article.content.blocks = [];
  assert.deepEqual(fxResponseToDoc(json).blocks, [{ type: 'p', text: 'プレビュー' }]);
});

test('通常の長文ポストと引用ポスト', () => {
  const doc = fxResponseToDoc({
    code: 200,
    tweet: {
      url: 'https://x.com/a/status/1',
      text: '一行目のタイトル\n\n本文です。',
      author: { name: 'A', screen_name: 'a' },
      quote: { text: '引用された内容', author: { name: 'B' } },
    },
  });
  assert.equal(doc.title, '一行目のタイトル');
  assert.deepEqual(doc.blocks, [
    { type: 'p', text: '一行目のタイトル' },
    { type: 'p', text: '本文です。' },
    { type: 'h', text: '引用：B' },
    { type: 'quote', text: '引用された内容' },
  ]);
});

test('取得失敗は日本語のエラーにする', () => {
  assert.throws(() => fxResponseToDoc({ code: 404, message: 'NOT_FOUND' }), /見つかりません/);
  assert.throws(() => fxResponseToDoc({ code: 401, message: 'PRIVATE_TWEET' }), /非公開/);
  assert.throws(() => fxResponseToDoc(null), /失敗/);
});
