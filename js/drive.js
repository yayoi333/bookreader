// Google Drive 連携（自分の Google Apps Script ウェブアプリ経由。gas/Code.gs を参照）
import { getSettings, saveSettings } from './settings.js';
import { sealSecret, openSecret } from './secret.js';

export function driveConfigured() {
  const s = getSettings();
  return Boolean(s.gasUrl && s.gasTokenBox);
}

/** トークンを暗号化して保存する。空文字なら消す */
export async function setGasToken(token) {
  saveSettings({ gasTokenBox: token ? await sealSecret(token) : null });
}

async function call(action, payload = {}) {
  const { gasUrl, gasTokenBox } = getSettings();
  const gasToken = await openSecret(gasTokenBox);
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
    if (json.error === 'tts') {
      // クラウド音声の失敗は、呼び出し側（engines/cloud.js）で言い換える
      const err = new Error(json.message || 'クラウド音声の生成に失敗しました');
      err.tts = true;
      err.status = json.status;
      err.raw = json.message || '';
      throw err;
    }
    if (json.error === 'summary_quota') {
      const err = new Error(json.message || 'AI要約の無料枠の上限に達しました');
      err.quota = true;
      throw err;
    }
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
  audioGet: (key) => call('audioGet', { key }),
  audioPut: (key, data) => call('audioPut', { key, data }),
  tts: (voice, text) => call('tts', { voice, text }),
  voices: () => call('voices'),
  summarize: (doc) => call('summarize', { title: doc.title, blocks: doc.blocks }),
  exportMd: (doc) => call('exportMd', { doc }),
};
