// 取り込み：URL / テキスト / ページのHTML → 文書 { title, url, author, source, blocks }
import { blocksFromPlainText, firstLine } from './text.js';
import { parseXUrl, fxApiUrl, fxResponseToDoc } from './x-article.js';
import { drive, driveConfigured } from './drive.js';

const URL_IN_TEXT = /https?:\/\/[^\s<>"'）)\]】」』]+/;

/** 入力欄・共有・ショートカットから来た文字列を判定して取り込む */
export async function importFromInput(input, { title } = {}) {
  const text = String(input ?? '').trim();
  if (!text) throw new Error('URLかテキストを入力してください');
  const url = text.match(URL_IN_TEXT)?.[0];
  // 「タイトル + URL」程度の短い文字列は URL 共有とみなす
  if (url && text.replace(url, '').trim().length < 200) return importFromUrl(url);
  return docFromText(text, title);
}

export async function importFromUrl(url) {
  const x = parseXUrl(url);
  if (x) return importX(x, url);
  let html;
  let finalUrl = url;
  if (driveConfigured()) {
    const res = await drive.fetchUrl(url);
    html = res.html;
    finalUrl = res.url || url;
  } else {
    try {
      const res = await fetch(url);
      html = await res.text();
    } catch {
      throw new Error(
        'このサイトはブラウザから直接取り込めません。設定でDrive連携(GAS)を入れるか、ブックマークレットで取り込んでください',
      );
    }
  }
  return docFromPageHtml(html, finalUrl);
}

async function importX({ id }, url) {
  let json;
  try {
    const res = await fetch(fxApiUrl(id));
    json = await res.json();
  } catch {
    throw new Error('Xの内容を取得できませんでした（通信エラー）。テキストをコピーして貼り付けることもできます');
  }
  return fxResponseToDoc(json, url);
}

export function docFromText(text, title) {
  const blocks = blocksFromPlainText(text);
  return { title: title || firstLine(text) || 'メモ', url: '', author: '', source: 'text', blocks };
}

/** ページのHTMLから本文だけを抜き出す（Mozilla Readability） */
export function docFromPageHtml(html, url, { selection } = {}) {
  if (selection && selection.trim().length > 20) {
    const doc = docFromText(selection);
    return { ...doc, url, source: 'web' };
  }
  const dom = new DOMParser().parseFromString(html, 'text/html');
  if (url) {
    const base = dom.createElement('base');
    base.href = url;
    dom.head?.prepend(base);
  }
  const fallbackTitle = dom.title;
  let article = null;
  if (typeof window.Readability === 'function') {
    try {
      article = new window.Readability(dom, { charThreshold: 200 }).parse();
    } catch {
      article = null;
    }
  }
  let blocks = [];
  if (article?.content) {
    const root = new DOMParser().parseFromString(article.content, 'text/html').body;
    blocks = htmlToBlocks(root);
  }
  if (!blocks.length) {
    const fresh = new DOMParser().parseFromString(html, 'text/html');
    fresh.querySelectorAll('script,style,noscript,nav,header,footer,aside,form').forEach((n) => n.remove());
    const main = fresh.querySelector('article, main, [role=main]') || fresh.body;
    blocks = htmlToBlocks(main);
  }
  if (!blocks.length) throw new Error('本文を見つけられませんでした。読みたい部分を選択してから取り込んでください');
  return {
    title: stripSiteName(article?.title || fallbackTitle) || firstLine(blocks[0].text),
    url,
    author: article?.byline || article?.siteName || '',
    source: 'web',
    blocks,
  };
}

/** 「記事名 | サイト名」「記事名 - サイト名」のサイト名部分を落とす */
export function stripSiteName(title) {
  const t = String(title || '').trim();
  const parts = t.split(/\s+[|｜\-–—]\s+|｜/);
  return parts.length > 1 && parts[0].trim().length >= 4 ? parts[0].trim() : t;
}

const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'BLOCKQUOTE', 'PRE', 'DIV', 'SECTION', 'ARTICLE',
  'UL', 'OL', 'DL', 'DT', 'DD', 'TABLE', 'TR', 'TD', 'TH', 'FIGURE', 'FIGCAPTION', 'MAIN', 'HEADER', 'FOOTER',
]);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'PRE', 'CODE', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'IFRAME', 'BUTTON', 'FORM']);

/** 本文HTML → ブロック配列（入れ子の重複を避けて末端のブロックだけ拾う） */
export function htmlToBlocks(root) {
  const blocks = [];
  const push = (type, text) => {
    const t = text.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (t) blocks.push({ type, text: t });
  };
  const typeOf = (tag) =>
    /^H[1-6]$/.test(tag) ? 'h' : tag === 'LI' ? 'li' : tag === 'BLOCKQUOTE' ? 'quote' : 'p';
  const walk = (el, inheritedType) => {
    let inline = '';
    const flush = () => {
      push(inheritedType || 'p', inline);
      inline = '';
    };
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        inline += node.textContent;
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = node.tagName;
        if (SKIP_TAGS.has(tag)) continue;
        if (tag === 'BR') {
          inline += '\n';
        } else if (BLOCK_TAGS.has(tag)) {
          flush();
          const own = typeOf(tag);
          walk(node, own === 'p' && inheritedType === 'quote' ? 'quote' : own === 'p' ? inheritedType : own);
        } else {
          inline += node.textContent;
        }
      }
    }
    flush();
  };
  walk(root, null);
  return blocks.map((b) => ({ type: b.type || 'p', text: b.text }));
}
