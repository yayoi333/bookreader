// テキスト処理（DOMに依存しない純粋関数。Node のテストからも読み込む）

const TERMINATORS = '。．！？!?';
const CLOSERS = '」』）)】〕”’"\'';
const SOFT_BREAKS = '、，,；;：: 　';

// Googleの高品質音声(Chirp 3 HD)は日本語で80〜100字を超える文を「長すぎる」と断ることがあるため短めに区切る
export const DEFAULT_MAX_SENTENCE = 80;

// Googleドキュメントの改行（\r や \u000b）も行の区切りとして扱う
const LINE_BREAK = /\r\n|[\r\n\u000b\u2028\u2029]/;

/** 文に分割する。長すぎる文は読点などで分割する（Chrome の長文途切れ対策） */
export function splitSentences(text, maxLen = DEFAULT_MAX_SENTENCE) {
  const out = [];
  for (const raw of String(text ?? '').split(LINE_BREAK)) {
    const line = raw.trim();
    if (!line) continue;
    let buf = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      buf += c;
      const isPeriod = c === '.' && (i + 1 >= line.length || /\s/.test(line[i + 1]));
      if (TERMINATORS.includes(c) || isPeriod) {
        while (i + 1 < line.length && (TERMINATORS.includes(line[i + 1]) || CLOSERS.includes(line[i + 1]))) {
          buf += line[++i];
        }
        pushSoftSplit(out, buf.trim(), maxLen);
        buf = '';
      }
    }
    pushSoftSplit(out, buf.trim(), maxLen);
  }
  return out;
}

function pushSoftSplit(out, s, max) {
  if (!s) return;
  while (s.length > max) {
    let cut = -1;
    for (let j = max - 1; j >= Math.floor(max * 0.4); j--) {
      if (SOFT_BREAKS.includes(s[j])) { cut = j + 1; break; }
    }
    if (cut < 0) cut = max;
    // サロゲートペアの途中で切らない
    const code = s.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    const head = s.slice(0, cut).trim();
    if (head) out.push(head);
    s = s.slice(cut).trim();
  }
  if (s) out.push(s);
}

/** 読み上げ用にノイズ（URL・絵文字・記号・Markdown）を取り除く。表示用テキストは変更しない */
export function normalizeForSpeech(input) {
  let s = String(input ?? '');
  s = s.replace(/https?:\/\/[^\s<>"'）)\]】」』]+/g, ' ');
  s = s.replace(/\bwww\.[^\s<>"'）)\]】」』]+/g, ' ');
  // 絵文字（ZWJ 連結・異体字セレクタ・肌色修飾を含む）
  s = s.replace(/\p{Extended_Pictographic}/gu, '');
  s = s.replace(/[‍︎️⃣]|[\u{1f3fb}-\u{1f3ff}]/gu, '');
  // 記号だけの行（区切り線など）
  s = s.replace(/^[\s\-_=―─━*＊・.。…~〜]+$/gm, '');
  // Markdown の強調・コード
  s = s.replace(/\*\*|__|~~|`+/g, '');
  // 行頭の引用記号・箇条書き記号・見出し記号
  s = s.replace(/^[\s>＞]+/gm, '');
  s = s.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|[・•●○◆◇■□▪▫▶►▼▽▲△★☆※✓✔☑→⇒➡]\s*|\d{1,2}[.)．）]\s+)/gm, '');
  // ハッシュタグ・メンションの記号だけ外す
  s = s.replace(/[#＃](?=[^\s#＃])/g, '');
  s = s.replace(/[@＠](?=[A-Za-z0-9_])/g, '');
  // 装飾記号
  s = s.replace(/[■□◆◇●○▼▽▲△★☆▶►▪▫•※]/g, ' ');
  s = s.replace(/[→⇒➡]|[\u2190-\u21ff]/g, '、');
  // 図形・その他の記号（◠ ◎ ♪ など）は読まない
  s = s.replace(/[\u25a0-\u25ff\u2600-\u27bf]/g, ' ');
  // 連続する感嘆符・疑問符・長音などをまとめる
  s = s.replace(/([！!？?])[！!？?]+/g, '$1');
  s = s.replace(/([。、…・〜~＝=―─━_\-])\1{2,}/g, '$1');
  s = s.replace(/[ \t　]+/g, ' ');
  return s.trim();
}

/** 文書ブロック配列 → 読み上げ単位（文）の配列 */
export function buildSegments(blocks, maxLen = DEFAULT_MAX_SENTENCE) {
  const segs = [];
  (blocks || []).forEach((b, bi) => {
    for (const t of splitSentences(b.text, maxLen)) {
      segs.push({ block: bi, text: t, speech: normalizeForSpeech(t) });
    }
  });
  return segs;
}

/** プレーンテキスト → ブロック配列（空行・改行で段落分け） */
export function blocksFromPlainText(text) {
  const blocks = [];
  for (const para of String(text ?? '').replace(/\r\n|[\r\u000b\u2028\u2029]/g, '\n').split(/\n{2,}/)) {
    const lines = para.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    // 箇条書きっぽい行は1行ずつブロックにする
    if (lines.length > 1 && lines.every((l) => /^([-*+・•●]|\d{1,2}[.)．）])\s*/.test(l))) {
      for (const l of lines) blocks.push({ type: 'li', text: l.replace(/^([-*+・•●]|\d{1,2}[.)．）])\s*/, '') });
      continue;
    }
    if (lines.length === 1 && /^#{1,6}\s+/.test(lines[0])) {
      blocks.push({ type: 'h', text: lines[0].replace(/^#{1,6}\s+/, '') });
      continue;
    }
    blocks.push({ type: 'p', text: lines.join('\n') });
  }
  return blocks;
}

export function firstLine(text, max = 40) {
  const line = String(text ?? '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const clean = line.replace(/https?:\/\/\S+/g, '').trim() || line;
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

const encoder = new TextEncoder();
export const byteLength = (s) => encoder.encode(s).length;

const ENDS_SENTENCE = /[。．！？!?」』）)】〕”"]$/;
const SOFT_END = /[、，,；;：:]$/;
const ASCII_WORD_END = /[A-Za-z0-9]$/;
const ASCII_WORD_START = /^[A-Za-z0-9]/;

/**
 * 読み上げ単位をクラウドTTS 1リクエスト分のチャンクにまとめる。
 * 最初のチャンクは小さくして再生開始を速くする。
 * 戻り値: [{ start, end, text, offsets: [{ i, at, len }] }]（end は含まない）
 */
export function chunkSegments(segs, { maxBytes = 4500, firstMaxBytes = 1000 } = {}) {
  const chunks = [];
  let cur = null;
  let curBytes = 0;
  let leadStart = null;
  let prevSeg = null;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s.speech) {
      if (cur) cur.end = i + 1;
      else if (leadStart === null) leadStart = i;
      continue;
    }
    // 段落の区切り方に依存しない連結にする（端末が違っても、Drive経由でも同じ文章＝同じ音声になる）
    let sep = '';
    if (cur && prevSeg) {
      if (ASCII_WORD_END.test(cur.text) && ASCII_WORD_START.test(s.speech)) {
        sep = ' ';
      } else if (!ENDS_SENTENCE.test(cur.text) && !SOFT_END.test(cur.text)) {
        sep = '。'; // 句点のない行（見出し・箇条書きなど）で文を区切る
      }
    }
    const limit = chunks.length === 0 ? firstMaxBytes : maxBytes;
    if (cur && curBytes + byteLength(sep + s.speech) > limit) {
      chunks.push(cur);
      cur = null;
      sep = '';
    }
    if (!cur) {
      cur = { start: leadStart ?? i, end: i + 1, text: '', offsets: [] };
      curBytes = 0;
      leadStart = null;
    }
    cur.text += sep;
    cur.offsets.push({ i, at: cur.text.length, len: s.speech.length });
    cur.text += s.speech;
    cur.end = i + 1;
    curBytes += byteLength(sep + s.speech);
    prevSeg = s;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** 読点で切った文に句点を補う（クラウドTTSの「文が長すぎる」エラー時の再試行用） */
export function terminateSoftSplits(chunk) {
  return chunk.offsets
    .map((o) => {
      const seg = chunk.text.slice(o.at, o.at + o.len);
      return ENDS_SENTENCE.test(seg) ? seg : seg.replace(SOFT_END, '') + '。';
    })
    .join('');
}

/** チャンク内の再生位置（0〜1）→ 読み上げ単位のインデックス */
export function segmentAtRatio(chunk, ratio) {
  const target = Math.max(0, Math.min(1, ratio)) * chunk.text.length;
  let idx = chunk.offsets[0]?.i ?? chunk.start;
  for (const o of chunk.offsets) {
    if (o.at <= target) idx = o.i;
    else break;
  }
  return idx;
}

/** 読み上げ単位のインデックス → チャンク内の位置（0〜1） */
export function ratioOfSegment(chunk, segIndex) {
  const o = chunk.offsets.find((x) => x.i >= segIndex);
  if (!o || !chunk.text.length) return 0;
  return o.at / chunk.text.length;
}

export function chunkIndexOf(chunks, segIndex) {
  for (let c = 0; c < chunks.length; c++) {
    if (segIndex < chunks[c].end) return c;
  }
  return -1;
}
