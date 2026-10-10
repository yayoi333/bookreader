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

/** 記事をGoogleドキュメントとして保存 */
function save_(req) {
  const title = String(req.title || '無題').slice(0, 200);
  const doc = DocumentApp.create(title);
  const body = doc.getBody();
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
    const text = String(b.text || '');
    if (!text.trim()) return;
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
  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  file.moveTo(getFolder_());
  if (req.url) file.setDescription(String(req.url));
  return { ok: true, id: doc.getId(), url: doc.getUrl() };
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
    files.push({ id: f.getId(), name: f.getName(), updated: f.getLastUpdated().getTime(), mimeType: f.getMimeType() });
  }
  files.sort(function (a, b) { return b.updated - a.updated; });
  return { ok: true, files: files.slice(0, 200) };
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
