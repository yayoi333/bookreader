import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSentences,
  normalizeForSpeech,
  buildSegments,
  blocksFromPlainText,
  chunkSegments,
  byteLength,
  segmentAtRatio,
  ratioOfSegment,
  chunkIndexOf,
  terminateSoftSplits,
} from '../js/text.js';

test('句点・感嘆符・閉じかっこで文を分ける', () => {
  assert.deepEqual(splitSentences('今日は晴れ。「本当に？」と聞いた！次の文'), [
    '今日は晴れ。',
    '「本当に？」',
    'と聞いた！',
    '次の文',
  ]);
});

test('改行でも分け、空行は捨てる', () => {
  assert.deepEqual(splitSentences('一行目\n\n二行目。三'), ['一行目', '二行目。', '三']);
});

test('英語のピリオドは後ろが空白のときだけ区切る', () => {
  assert.deepEqual(splitSentences('Version 3.14 is out. Try it'), ['Version 3.14 is out.', 'Try it']);
});

test('長い文は読点で分割し、上限を超えない', () => {
  const long = 'あ'.repeat(50) + '、' + 'い'.repeat(50) + '、' + 'う'.repeat(50) + '。';
  const parts = splitSentences(long, 120);
  assert.ok(parts.length >= 2);
  for (const p of parts) assert.ok(p.length <= 120, p.length);
  assert.equal(parts.join(''), long);
});

test('区切りがない長文も上限で切る', () => {
  const parts = splitSentences('か'.repeat(300), 120);
  assert.deepEqual(parts.map((p) => p.length), [120, 120, 60]);
});

test('読み上げ用の整形：URL・絵文字・記号を除く', () => {
  assert.equal(normalizeForSpeech('詳しくは https://example.com/a?b=1 を見て🙏✨'), '詳しくは を見て');
  assert.equal(normalizeForSpeech('■ポイント\n・その1\n## 見出し'), 'ポイント\nその1\n見出し');
  assert.equal(normalizeForSpeech('**大事**な #AI の話 @user_1 より'), '大事な AI の話 user_1 より');
  assert.equal(normalizeForSpeech('すごい！！！！本当？？'), 'すごい！本当？');
  assert.equal(normalizeForSpeech('A→B'), 'A、B');
  assert.equal(normalizeForSpeech('----------'), '');
  assert.equal(normalizeForSpeech('👨‍👩‍👧家族'), '家族');
});

test('ブロックから読み上げ単位を作る', () => {
  const segs = buildSegments([
    { type: 'h', text: 'はじめに' },
    { type: 'p', text: '一文目。二文目。' },
  ]);
  assert.deepEqual(
    segs.map((s) => [s.block, s.text]),
    [
      [0, 'はじめに'],
      [1, '一文目。'],
      [1, '二文目。'],
    ],
  );
});

test('プレーンテキストを段落・見出し・箇条書きに分ける', () => {
  const blocks = blocksFromPlainText('# タイトル\n\n本文1行目\n本文2行目\n\n- a\n- b');
  assert.deepEqual(blocks, [
    { type: 'h', text: 'タイトル' },
    { type: 'p', text: '本文1行目\n本文2行目' },
    { type: 'li', text: 'a' },
    { type: 'li', text: 'b' },
  ]);
});

test('チャンク分割：バイト上限を守り、最初は小さく、全文を漏れなく含む', () => {
  const blocks = [];
  for (let i = 0; i < 40; i++) blocks.push({ type: 'p', text: `これは${i}番目の段落です。`.repeat(5) });
  const segs = buildSegments(blocks);
  const chunks = chunkSegments(segs, { maxBytes: 4500, firstMaxBytes: 1000 });
  assert.ok(chunks.length > 1);
  assert.ok(byteLength(chunks[0].text) <= 1000);
  for (const c of chunks) assert.ok(byteLength(c.text) <= 4500);
  // 連続していて抜けがない
  assert.equal(chunks[0].start, 0);
  for (let i = 1; i < chunks.length; i++) assert.equal(chunks[i].start, chunks[i - 1].end);
  assert.equal(chunks.at(-1).end, segs.length);
  const all = chunks.flatMap((c) => c.offsets.map((o) => c.text.slice(o.at, o.at + o.len)));
  assert.deepEqual(all, segs.map((s) => s.speech));
});

test('句点のない行の後には句点を補い、英単語の間には空白を入れる', () => {
  const segs = [
    { block: 0, text: '見出し', speech: '見出し' },
    { block: 1, text: 'Hello', speech: 'Hello' },
    { block: 1, text: 'world.', speech: 'world.' },
  ];
  const [c] = chunkSegments(segs);
  assert.equal(c.text, '見出し。Hello world.');
});

test('段落の分け方が違っても同じ音声用テキストになる（端末間・Drive経由で音声を使い回すため）', () => {
  const oneBlock = buildSegments([{ type: 'p', text: '一行目\n二行目。三行目' }]);
  const split = buildSegments([{ type: 'p', text: '一行目' }, { type: 'p', text: '二行目。' }, { type: 'p', text: '三行目' }]);
  const gdocs = buildSegments([{ type: 'p', text: '一行目\r二行目。\u000b三行目' }]);
  const text = (segs) => chunkSegments(segs).map((c) => c.text).join('|');
  assert.equal(text(oneBlock), '一行目。二行目。三行目');
  assert.equal(text(split), text(oneBlock));
  assert.equal(text(gdocs), text(oneBlock));
});

test('表の区切り（｜）は文の区切りにし、修飾文字（ˆ）は読まない', () => {
  assert.equal(normalizeForSpeech('項目 | 内容｜料金ˆ'), '項目。内容。料金');
});

test('記号（◠ ♪ ◎ 矢印など）は読まない', () => {
  assert.equal(normalizeForSpeech('◠◠《項目》♪ A⇔B'), '《項目》 A、B');
});

test('読み上げ対象が空の文（URLだけ等）はチャンクに吸収される', () => {
  const segs = buildSegments([
    { type: 'p', text: 'https://example.com' },
    { type: 'p', text: '本文です。' },
    { type: 'p', text: '🎉' },
  ]);
  const chunks = chunkSegments(segs);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks[0].end, 3);
  assert.equal(chunkIndexOf(chunks, 0), 0);
  assert.equal(chunkIndexOf(chunks, 2), 0);
  assert.equal(chunkIndexOf(chunks, 3), -1);
});

test('再生位置と読み上げ単位の対応', () => {
  const segs = buildSegments([{ type: 'p', text: 'あいう。かきく。さしす。' }]);
  const [c] = chunkSegments(segs);
  assert.equal(segmentAtRatio(c, 0), 0);
  assert.equal(segmentAtRatio(c, 0.5), 1);
  assert.equal(segmentAtRatio(c, 0.99), 2);
  assert.equal(ratioOfSegment(c, 0), 0);
  assert.ok(Math.abs(ratioOfSegment(c, 1) - 4 / 12) < 1e-9);
});

test('「文が長すぎる」ときの再試行用：すべての文を句点で終わらせ、二重の句点は作らない', () => {
  const segs = buildSegments([
    { type: 'h', text: '見出し' },
    { type: 'p', text: 'あ'.repeat(70) + '、' + 'い'.repeat(70) + '。' },
  ]);
  const [c] = chunkSegments(segs);
  assert.equal(terminateSoftSplits(c), '見出し。' + 'あ'.repeat(70) + '。' + 'い'.repeat(70) + '。');
});

test('文の長さは既定で80字以内（Googleの高品質音声の制限対策）', () => {
  const segs = buildSegments([{ type: 'p', text: 'う'.repeat(500) }]);
  assert.ok(segs.every((s) => s.text.length <= 80));
});
