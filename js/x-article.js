// X（旧Twitter）のポスト・記事の取り込み。
// 公式APIは有料のため、無料・認証不要の FxTwitter API（非公式）を使う。
import { blocksFromPlainText, firstLine } from './text.js';

const X_HOST = /^(?:x|twitter|fxtwitter|fixupx|vxtwitter|fixvx)\.com$/;

export function parseXUrl(input) {
  let u;
  try {
    u = new URL(String(input).trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase().replace(/^(?:www|mobile|m)\./, '');
  if (!X_HOST.test(host)) return null;
  const m = u.pathname.match(/\/(?:status|statuses|article)\/(\d+)/);
  if (!m) return null;
  const h = u.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/(?:status|statuses|article)\//);
  const handle = h && h[1] !== 'i' ? h[1] : null;
  return { id: m[1], handle };
}

export const fxApiUrl = (id) => `https://api.fxtwitter.com/status/${id}`;

const BLOCK_TYPES = {
  'header-one': 'h',
  'header-two': 'h',
  'header-three': 'h',
  blockquote: 'quote',
  'ordered-list-item': 'li',
  'unordered-list-item': 'li',
  unstyled: 'p',
};

/** X記事（Draft.js 形式の content_state）→ ブロック配列。画像などの atomic ブロックは読まない */
export function articleToBlocks(article) {
  const blocks = [];
  for (const b of article?.content?.blocks || []) {
    if (b.type === 'atomic') continue;
    const text = String(b.text || '').trim();
    if (!text) continue;
    blocks.push({ type: BLOCK_TYPES[b.type] || 'p', text });
  }
  return blocks;
}

const ERRORS = {
  401: 'このポストは非公開のため取得できません',
  404: 'ポストが見つかりません（削除済み・URL違いの可能性）',
  500: 'Xからの取得に失敗しました（時間をおいて再試行してください）',
};

/** FxTwitter API v1 のレスポンス → 文書 */
export function fxResponseToDoc(json, sourceUrl) {
  if (!json || json.code !== 200 || !json.tweet) {
    throw new Error(ERRORS[json?.code] || `Xからの取得に失敗しました（${json?.message || '不明なエラー'}）`);
  }
  const t = json.tweet;
  const author = t.author ? `${t.author.name} (@${t.author.screen_name})` : '';
  const base = {
    url: t.url || sourceUrl,
    source: 'x',
    author,
    publishedAt: t.created_timestamp ? t.created_timestamp * 1000 : null,
  };
  if (t.article && (t.article.content?.blocks?.length || t.article.title)) {
    const blocks = articleToBlocks(t.article);
    if (!blocks.length && t.article.preview_text) blocks.push({ type: 'p', text: t.article.preview_text });
    return { ...base, title: t.article.title || firstLine(t.text) || 'Xの記事', blocks };
  }
  const blocks = blocksFromPlainText(t.text || '');
  const q = t.quote;
  if (q && q.text) {
    blocks.push({ type: 'h', text: `引用：${q.author?.name || ''}` });
    blocks.push(...blocksFromPlainText(q.text).map((b) => ({ ...b, type: b.type === 'p' ? 'quote' : b.type })));
  }
  const title = firstLine(t.text) || (t.author ? `${t.author.name}のポスト` : 'Xのポスト');
  return { ...base, title, blocks };
}
