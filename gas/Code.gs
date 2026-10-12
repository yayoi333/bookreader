/**
 * よみあげ文庫 — Google Drive 連携用 Google Apps Script
 *
 * 使い方（初回のみ）:
 *   1. https://script.google.com/ で新しいプロジェクトを作り、このファイルの中身を貼り付けて保存
 *   2. 上の関数選択で「setup」を選んで実行 → 権限を許可 → 実行ログに出る TOKEN を控える
 *   3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
 *        次のユーザーとして実行: 自分 / アクセスできるユーザー: 全員
 *      → 表示された URL（…/exec）を控える
 *   4. よみあげ文庫の設定画面に URL と TOKEN を入れて「接続テスト」
 *   5. （クラウド音声を使う場合）左の「プロジェクトの設定」→「スクリプト プロパティ」に
 *        プロパティ: TTS_API_KEY / 値: Google Cloud の APIキー
 *      を追加する。キーはここにだけ置き、アプリ（ブラウザ）には保存しない。
 *   6. （旧版「自分専用の図書館」の引っ越し）関数選択で「importOldLibrary」を選んで1回実行
 *   7. （AI要約を使う場合）https://aistudio.google.com/apikey で Gemini の APIキーを作り、
 *      スクリプト プロパティに GEMINI_API_KEY として追加。関数「testSummarize」を実行すると、
 *      「よみあげ文庫」フォルダの最新の記事を要約して実行ログに出す。
 *      モデルを変えたいときは GEMINI_MODEL も追加（無ければ gemini-3.5-flash-lite）。
 *
 * コードを書き換えたら「デプロイを管理」→ 編集 → バージョン「新バージョン」で更新（URLは変わらない）。
 */

const FOLDER_NAME = 'よみあげ文庫';
const READABLE_MIME = [MimeType.GOOGLE_DOCS, MimeType.PLAIN_TEXT, 'text/markdown', 'text/x-markdown'];

function setup() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, ''));
  }
  const folder = getFolder_();
  Logger.log('TOKEN: ' + props.getProperty('TOKEN'));
  Logger.log('保存先フォルダ: ' + folder.getName() + ' (' + folder.getUrl() + ')');
}

function doGet() {
  return json_({ ok: true, app: 'yomiage', message: 'よみあげ文庫のDrive連携は動いています（POSTで呼び出します）' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const token = PropertiesService.getScriptProperties().getProperty('TOKEN');
    if (!token || req.token !== token) return json_({ ok: false, error: 'unauthorized' });
    switch (req.action) {
      case 'ping':
        return json_({ ok: true, folder: getFolder_().getName() });
      case 'fetch':
        return json_(fetchPage_(req.url));
      case 'save':
        return json_(save_(req));
      case 'list':
        return json_(list_(req.q));
      case 'get':
        return json_(get_(req.id));
      case 'audioGet':
        return json_(audioGet_(req.key));
      case 'audioPut':
        return json_(audioPut_(req.key, req.data));
      case 'tts':
        return json_(tts_(req.voice, req.text));
      case 'voices':
        return json_(voices_());
      case 'summarize':
        return json_(summarize_(req.title, req.blocks));
      default:
        return json_({ ok: false, error: '不明な操作です: ' + req.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // フォルダが消されていたら作り直す
    }
  }
  const it = DriveApp.getFoldersByName(FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

/** Web記事のHTMLをサーバー側で取得（ブラウザのCORS制限を回避） */
function fetchPage_(url) {
  if (!/^https?:\/\//.test(String(url || ''))) throw new Error('URLが正しくありません');
  const res = UrlFetchApp.fetch(url, {
    followRedirects: true,
    muteHttpExceptions: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36',
      'Accept-Language': 'ja,en;q=0.8',
    },
  });
  const code = res.getResponseCode();
  if (code >= 400) throw new Error('ページを取得できませんでした（HTTP ' + code + '）');
  const blob = res.getBlob();
  const head = blob.getDataAsString('ISO-8859-1').slice(0, 4000);
  const ct = String(res.getHeaders()['Content-Type'] || res.getHeaders()['content-type'] || '');
  const m = (ct + ' ' + head).match(/charset=["']?([\w-]+)/i);
  let charset = m ? m[1].toLowerCase() : 'utf-8';
  if (/shift_jis|sjis|x-sjis|windows-31j|cp932/.test(charset)) charset = 'Shift_JIS';
  else if (/euc-jp/.test(charset)) charset = 'EUC-JP';
  else charset = 'UTF-8';
  return { ok: true, url: url, html: blob.getDataAsString(charset) };
}

/** 同じURLの記事がフォルダにあれば返す（二重保存を防ぐ） */
function findByUrl_(url) {
  if (!url) return null;
  const it = getFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getMimeType() === MimeType.GOOGLE_DOCS && f.getDescription() === url) return f;
  }
  return null;
}

/** 記事をGoogleドキュメントとして保存（同じURLの記事は上書き） */
function save_(req) {
  const title = String(req.title || '無題').slice(0, 200);
  const existing = findByUrl_(req.url);
  const doc = existing ? DocumentApp.openById(existing.getId()) : DocumentApp.create(title);
  const body = doc.getBody();
  if (existing) {
    body.clear();
    doc.setName(title);
  }
  // 新規ドキュメントに最初の空段落があるとは限らない（無い場合もある）ので、追加してから空段落を消す
  const leading = body.getParagraphs();
  body.appendParagraph(title).setHeading(DocumentApp.ParagraphHeading.TITLE);
  leading.forEach(function (p) {
    if (!p.getText()) {
      try {
        p.removeFromParent();
      } catch (e) {
        // 最後の1段落は消せないことがあるが、残っても害はない
      }
    }
  });
  const meta = [req.author, req.url].filter(String).join(' / ');
  if (meta) {
    const p = body.appendParagraph(meta).setHeading(DocumentApp.ParagraphHeading.SUBTITLE);
    if (req.url) {
      const start = meta.length - String(req.url).length;
      p.editAsText().setLinkUrl(start, meta.length - 1, req.url);
    }
  }
  (req.blocks || []).forEach(function (b) {
    // 段落内の改行は別の段落にする（読み戻したときに文の区切りが変わらないように）
    String(b.text || '').split('\n').forEach(function (line) {
      const text = line.trim();
      if (!text) return;
      if (b.type === 'h') {
        body.appendParagraph(text).setHeading(DocumentApp.ParagraphHeading.HEADING2);
      } else if (b.type === 'li') {
        body.appendListItem(text).setGlyphType(DocumentApp.GlyphType.BULLET);
      } else if (b.type === 'quote') {
        body.appendParagraph(text).setIndentStart(36).setIndentFirstLine(36).setItalic(true);
      } else {
        body.appendParagraph(text);
      }
    });
  });
  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  if (!existing) file.moveTo(getFolder_());
  if (req.url) file.setDescription(String(req.url));
  return { ok: true, id: doc.getId(), url: doc.getUrl(), updated: Boolean(existing) };
}

/** 一覧：q が空なら「よみあげ文庫」フォルダ、あればDrive全体をファイル名で検索 */
function list_(q) {
  const files = [];
  let it;
  if (q) {
    const safe = String(q).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const mime = READABLE_MIME.map(function (m) { return "mimeType = '" + m + "'"; }).join(' or ');
    it = DriveApp.searchFiles("title contains '" + safe + "' and trashed = false and (" + mime + ')');
  } else {
    it = getFolder_().getFiles();
  }
  while (it.hasNext() && files.length < 300) {
    const f = it.next();
    if (READABLE_MIME.indexOf(f.getMimeType()) < 0 && !/\.(txt|md)$/i.test(f.getName())) continue;
    files.push({
      id: f.getId(),
      name: f.getName(),
      updated: f.getLastUpdated().getTime(),
      mimeType: f.getMimeType(),
      source: f.getDescription() || '',
    });
  }
  files.sort(function (a, b) { return b.updated - a.updated; });
  // 以前の版で二重保存された記事は、新しい方だけ見せる
  const seen = {};
  const unique = files.filter(function (f) {
    if (!f.source) return true;
    if (seen[f.source]) return false;
    seen[f.source] = true;
    return true;
  });
  unique.forEach(function (f) { delete f.source; });
  return { ok: true, files: unique.slice(0, 200) };
}

/** 中身を取得：Googleドキュメントは見出し・箇条書きを保ったブロックで返す */
function get_(id) {
  const file = DriveApp.getFileById(id);
  const mime = file.getMimeType();
  const result = { ok: true, title: file.getName(), url: file.getUrl(), sourceUrl: file.getDescription() || '' };
  if (mime === MimeType.GOOGLE_DOCS) {
    const blocks = [];
    const body = DocumentApp.openById(id).getBody();
    const n = body.getNumChildren();
    for (let i = 0; i < n; i++) {
      const el = body.getChild(i);
      const type = el.getType();
      if (type === DocumentApp.ElementType.LIST_ITEM) {
        const t = el.asListItem().getText().trim();
        if (t) blocks.push({ type: 'li', text: t });
      } else if (type === DocumentApp.ElementType.PARAGRAPH) {
        const p = el.asParagraph();
        const t = p.getText().trim();
        if (!t) continue;
        const h = p.getHeading();
        if (h === DocumentApp.ParagraphHeading.TITLE || h === DocumentApp.ParagraphHeading.SUBTITLE) continue;
        blocks.push({ type: h === DocumentApp.ParagraphHeading.NORMAL ? 'p' : 'h', text: t });
      } else if (type === DocumentApp.ElementType.TABLE) {
        const t = el.asTable().getText().trim();
        if (t) blocks.push({ type: 'p', text: t });
      }
    }
    result.blocks = blocks;
  } else {
    result.text = file.getBlob().getDataAsString('UTF-8');
  }
  return result;
}

// ---- 生成した音声の共有（別の端末で作り直さない） ----

function audioFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('AUDIO_FOLDER_ID');
  if (id) {
    try {
      return DriveApp.getFolderById(id);
    } catch (e) {
      // 消されていたら作り直す
    }
  }
  const parent = getFolder_();
  const it = parent.getFoldersByName('音声キャッシュ');
  const folder = it.hasNext() ? it.next() : parent.createFolder('音声キャッシュ');
  props.setProperty('AUDIO_FOLDER_ID', folder.getId());
  return folder;
}

function audioName_(key) {
  if (!/^[0-9a-f]{64}$/.test(String(key || ''))) throw new Error('音声のキーが正しくありません');
  return key + '.mp3';
}

function audioGet_(key) {
  const it = audioFolder_().getFilesByName(audioName_(key));
  if (!it.hasNext()) return { ok: true, found: false };
  return { ok: true, found: true, data: Utilities.base64Encode(it.next().getBlob().getBytes()) };
}

function audioPut_(key, data) {
  const name = audioName_(key);
  const folder = audioFolder_();
  if (folder.getFilesByName(name).hasNext()) return { ok: true, existed: true };
  folder.createFile(Utilities.newBlob(Utilities.base64Decode(String(data || '')), 'audio/mpeg', name));
  return { ok: true };
}

// ---- クラウド音声（Google Cloud Text-to-Speech）の代理生成 ----
// APIキーはスクリプトプロパティ TTS_API_KEY にだけ置く。アプリ側にはキーを渡さない。

const TTS_API = 'https://texttospeech.googleapis.com/v1';

function ttsKey_() {
  const key = PropertiesService.getScriptProperties().getProperty('TTS_API_KEY');
  if (!key) throw new Error('クラウド音声のAPIキーが未設定です（GASの「スクリプト プロパティ」に TTS_API_KEY を追加）');
  return key;
}

/** Google の応答をアプリに返す形にする。失敗は status と生のメッセージを付けて返し、アプリ側で言い換える */
function ttsFetch_(path, options) {
  const res = UrlFetchApp.fetch(TTS_API + path + (path.indexOf('?') < 0 ? '?' : '&') + 'key=' + encodeURIComponent(ttsKey_()),
    Object.assign({ muteHttpExceptions: true }, options || {}));
  const code = res.getResponseCode();
  let body = {};
  try {
    body = JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    body = {};
  }
  if (code >= 400) {
    return { ok: false, error: 'tts', status: code, message: (body.error && body.error.message) || '' };
  }
  return { ok: true, body: body };
}

function tts_(voice, text) {
  voice = String(voice || '');
  text = String(text || '');
  if (!/^[a-z]{2,3}-[A-Z]{2}-[\w-]+$/.test(voice)) throw new Error('声の名前が正しくありません');
  if (!text) throw new Error('読み上げる文章がありません');
  const languageCode = voice.split('-').slice(0, 2).join('-');
  const r = ttsFetch_('/text:synthesize', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      input: { text: text },
      voice: { languageCode: languageCode, name: voice },
      // 速度は再生側で変えるので、生成は等速
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });
  if (!r.ok) return r;
  return { ok: true, data: r.body.audioContent || '', chars: text.length };
}

function voices_() {
  const r = ttsFetch_('/voices?languageCode=ja-JP', { method: 'get' });
  if (!r.ok) return r;
  return { ok: true, voices: r.body.voices || [] };
}

// ---- 旧版「自分専用の図書館」からの引っ越し（GASエディタで importOldLibrary を1回実行） ----
// 旧フォルダのファイルは読むだけで、消したり書き換えたりしない。

const OLD_FOLDER_NAME = '自分専用の図書館';

/** 旧版のブロック → 新版のブロック。画像・動画は読み上げないので移さない */
function convertOldBlocks_(blocks) {
  const out = [];
  (blocks || []).forEach(function (b) {
    if (!b) return;
    if (b.type === 'heading' && b.text) out.push({ type: 'h', text: String(b.text) });
    else if (b.type === 'paragraph' && b.text) out.push({ type: 'p', text: String(b.text) });
    else if (b.type === 'quote' && b.text) out.push({ type: 'quote', text: String(b.text) });
    else if (b.type === 'list') {
      (b.items || []).forEach(function (item) {
        const t = typeof item === 'string' ? item : item && item.text;
        if (t) out.push({ type: 'li', text: String(t) });
      });
    }
  });
  return out;
}

/** 同じ記事（同じ元URL）が複数あれば、保存日が新しい方だけ残す */
function pickLatestOld_(records) {
  const byUrl = {};
  const noUrl = [];
  records.forEach(function (r) {
    const url = r.sourceUrl || '';
    if (!url) return noUrl.push(r);
    if (!byUrl[url] || String(r.savedAt || '') > String(byUrl[url].savedAt || '')) byUrl[url] = r;
  });
  return Object.keys(byUrl).map(function (k) { return byUrl[k]; }).concat(noUrl);
}

function importOldLibrary() {
  const it = DriveApp.getFoldersByName(OLD_FOLDER_NAME);
  if (!it.hasNext()) throw new Error('Driveに「' + OLD_FOLDER_NAME + '」フォルダが見つかりません');
  const files = it.next().getFiles();
  const records = [];
  while (files.hasNext()) {
    const f = files.next();
    if (!/\.json$/i.test(f.getName())) continue;
    try {
      records.push(JSON.parse(f.getBlob().getDataAsString('UTF-8')));
    } catch (e) {
      Logger.log('読めないファイルを飛ばしました: ' + f.getName());
    }
  }
  const result = { found: records.length, saved: 0, skipped: 0 };
  pickLatestOld_(records).forEach(function (r) {
    const blocks = convertOldBlocks_(r.blocks);
    if (!blocks.length) {
      result.skipped++;
      return;
    }
    save_({ title: r.title, url: r.sourceUrl || '', author: r.author || '', blocks: blocks });
    result.saved++;
  });
  Logger.log('旧版の引っ越し: JSON ' + result.found + '件 → 保存 ' + result.saved + '件（本文なしで飛ばした ' + result.skipped + '件）');
  return result;
}

// ---- AI要約（Gemini API。APIキーはスクリプトプロパティ GEMINI_API_KEY にだけ置く） ----

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models/';
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite'; // 2026-10-09 時点で無料枠あり・低コスト向けの安定版
const SUMMARY_MAX_CHARS = 60000; // これより長い記事は先頭だけを要約する

const SUMMARY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    tldr: { type: 'STRING' },
    points: { type: 'ARRAY', items: { type: 'STRING' } },
    terms: {
      type: 'ARRAY',
      items: { type: 'OBJECT', properties: { word: { type: 'STRING' }, note: { type: 'STRING' } }, required: ['word', 'note'] },
    },
    verdict: {
      type: 'OBJECT',
      properties: { level: { type: 'STRING', enum: ['高', '中', '低'] }, reason: { type: 'STRING' } },
      required: ['level', 'reason'],
    },
  },
  required: ['tldr', 'points', 'terms', 'verdict'],
};

function summaryPrompt_(title, text, truncated) {
  return [
    'あなたは、忙しい読者のために記事の「下読み」をする編集者です。次の記事を日本語で要約してください。',
    '',
    '出力はJSONだけ。形式:',
    '{"tldr": "結論を1〜2文", "points": ["要点", ...3〜5個], "terms": [{"word": "難しい用語", "note": "ひとこと解説"}, ...0〜5個], "verdict": {"level": "高|中|低", "reason": "全文を読む価値の理由を1文"}}',
    '',
    'ルール:',
    '- 記事に書かれていることだけを書く。推測や一般論を足さない',
    '- 耳で聞いても分かる、短い話し言葉寄りの文にする（1文60字以内を目安）',
    '- URL・絵文字・記号の羅列は入れない',
    '- verdict は、要約だけで足りるなら「低」、全文に要約で拾えない具体例や手順が多いなら「高」',
    truncated ? '- 記事が長いため先頭部分だけを渡しています。その範囲で要約してください' : null,
    '',
    'タイトル: ' + title,
    '本文:',
    text,
  ].filter(function (l) { return l !== null; }).join('\n');
}

/** ブロック → 要約に渡す本文（見出しは「■」、箇条書きは「・」を付けて構造を残す） */
function blocksToText_(blocks) {
  return (blocks || []).map(function (b) {
    const t = String((b && b.text) || '').trim();
    if (!t) return '';
    if (b.type === 'h') return '■ ' + t;
    if (b.type === 'li') return '・' + t;
    if (b.type === 'quote') return '「' + t + '」';
    return t;
  }).filter(String).join('\n');
}

/** Gemini の返事（JSON文字列。```json で囲まれていることもある）→ 要約。形が違えば例外 */
function parseSummary_(raw) {
  const text = String(raw || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('要約の形式が読めません');
  const j = JSON.parse(text.slice(start, end + 1));
  const str = function (v) { return String(v == null ? '' : v).trim(); };
  const level = str(j.verdict && j.verdict.level);
  const out = {
    tldr: str(j.tldr),
    points: (Array.isArray(j.points) ? j.points : []).map(str).filter(String).slice(0, 7),
    terms: (Array.isArray(j.terms) ? j.terms : [])
      .map(function (t) { return { word: str(t && t.word), note: str(t && t.note) }; })
      .filter(function (t) { return t.word && t.note; })
      .slice(0, 8),
    verdict: { level: ['高', '中', '低'].indexOf(level) >= 0 ? level : '中', reason: str(j.verdict && j.verdict.reason) },
  };
  if (!out.tldr || !out.points.length) throw new Error('要約の中身が空です');
  return out;
}

function geminiCall_(model, key, prompt, useSchema) {
  const generationConfig = { responseMimeType: 'application/json', temperature: 0.2 };
  if (useSchema) generationConfig.responseSchema = SUMMARY_SCHEMA;
  const res = UrlFetchApp.fetch(GEMINI_API + encodeURIComponent(model) + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    muteHttpExceptions: true,
    payload: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: generationConfig }),
  });
  let body = {};
  try {
    body = JSON.parse(res.getContentText() || '{}');
  } catch (e) {
    body = {};
  }
  return { code: res.getResponseCode(), body: body };
}

function summarize_(title, blocks) {
  const props = PropertiesService.getScriptProperties();
  const key = props.getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, error: 'AI要約のAPIキーが未設定です（GASの「スクリプト プロパティ」に GEMINI_API_KEY を追加）' };
  const model = props.getProperty('GEMINI_MODEL') || DEFAULT_GEMINI_MODEL;
  title = String(title || '無題');
  let text = blocksToText_(blocks);
  if (!text) return { ok: false, error: '要約する本文がありません' };
  const truncated = text.length > SUMMARY_MAX_CHARS;
  if (truncated) text = text.slice(0, SUMMARY_MAX_CHARS);
  const prompt = summaryPrompt_(title, text, truncated);

  let r = geminiCall_(model, key, prompt, true);
  // 出力の型指定に対応していないモデルなら、型指定なしでもう一度だけ試す
  if (r.code === 400 && /schema|response_?mime/i.test(JSON.stringify(r.body))) {
    r = geminiCall_(model, key, prompt, false);
  }
  if (r.code === 429) return { ok: false, error: 'summary_quota', message: 'AI要約の無料枠の上限に達しました。時間をおいて「要約する」を押してください' };
  if (r.code >= 400) {
    const m = (r.body.error && r.body.error.message) || '';
    if (/API key not valid|API_KEY_INVALID/i.test(m)) return { ok: false, error: 'GEMINI_API_KEY が正しくありません' };
    if (/not found|is not supported/i.test(m)) return { ok: false, error: 'モデル「' + model + '」が使えません（GEMINI_MODEL を確認）：' + m };
    return { ok: false, error: 'AI要約に失敗しました（' + r.code + '）：' + m };
  }
  const cand = r.body.candidates && r.body.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const raw = parts.map(function (p) { return p.text || ''; }).join('');
  if (!raw) {
    const reason = (cand && cand.finishReason) || (r.body.promptFeedback && r.body.promptFeedback.blockReason) || '不明';
    return { ok: false, error: 'AI要約が空で返りました（理由: ' + reason + '）' };
  }
  let summary;
  try {
    summary = parseSummary_(raw);
  } catch (e) {
    return { ok: false, error: 'AI要約の形式が想定と違いました：' + e.message };
  }
  summary.model = model;
  summary.truncated = truncated;
  summary.at = Date.now();
  return { ok: true, summary: summary };
}

/** GASエディタでの動作確認用：「よみあげ文庫」フォルダの最新の記事を要約してログに出す */
function testSummarize() {
  const files = list_('').files;
  if (!files.length) throw new Error('「よみあげ文庫」フォルダに記事がありません');
  const doc = get_(files[0].id);
  const blocks = doc.blocks || String(doc.text || '').split(/\n+/).map(function (t) { return { type: 'p', text: t }; });
  const res = summarize_(doc.title, blocks);
  Logger.log('記事: ' + doc.title);
  Logger.log(JSON.stringify(res, null, 2));
  return res;
}
