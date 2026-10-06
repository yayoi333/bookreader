// Google Drive 連携（自分の Google Apps Script ウェブアプリ経由。gas/Code.gs を参照）
import { getSettings } from './settings.js';

export function driveConfigured() {
  const s = getSettings();
  return Boolean(s.gasUrl && s.gasToken);
}

async function call(action, payload = {}) {
  const { gasUrl, gasToken } = getSettings();
  if (!gasUrl || !gasToken) throw new Error('Drive連携が未設定です（設定画面でGASのURLとトークンを入力）');
  let res;
  try {
    // text/plain にするとプリフライトが発生せず、GAS でも CORS で受け取れる
    res = await fetch(gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ token: gasToken, action, ...payload }),
      redirect: 'follow',
    });
  } catch {
    throw new Error('Drive連携(GAS)に接続できません。URLとデプロイ設定（アクセス:全員）を確認してください');
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error('GASからの応答が読めません。ウェブアプリとして公開されているか確認してください');
  }
  if (!json.ok) {
    if (json.error === 'unauthorized') throw new Error('トークンが違います（GASの setup 実行時に表示された値を入力）');
    throw new Error(json.error || 'Drive連携でエラーが発生しました');
  }
  return json;
}

export const drive = {
  ping: () => call('ping'),
  fetchUrl: (url) => call('fetch', { url }),
  save: (doc) =>
    call('save', {
      title: doc.title,
      url: doc.url || '',
      author: doc.author || '',
      blocks: doc.blocks,
    }),
  list: (q = '') => call('list', { q }),
  get: (id) => call('get', { id }),
};
