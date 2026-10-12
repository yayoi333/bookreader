// 設定（端末ごとに localStorage に保存）。秘密の値は平文で置かない（js/secret.js）
import { sealSecret } from './secret.js';

const KEY = 'yomiage.settings.v1';

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(navigator.userAgent);

const DEFAULTS = {
  engine: 'device', // 'device' = 端末の声（無料） / 'cloud' = Google Cloud TTS（GAS経由で音声ファイル化）
  rate: 1.0,
  deviceVoice: '',
  cloudVoice: 'ja-JP-Chirp3-HD-Aoede',
  fontSize: 18,
  autoScroll: true,
  wakeLock: false,
  keepAlive: isAndroid, // 端末の声の再生中に無音を流して止まりにくくする（実験的）
  gasUrl: '',
  gasTokenBox: null, // GAS のトークン（暗号文 { iv, data }）
  autoSaveDrive: false,
  driveAudio: true, // クラウド音声をDriveにも保存して、別の端末で作り直さない
};

let cache;

export function getSettings() {
  if (!cache) {
    let saved = {};
    try {
      saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    } catch {
      saved = {};
    }
    cache = { ...DEFAULTS, ...saved };
  }
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // プライベートブラウズ等で保存できなくても動作は続ける
  }
  window.dispatchEvent(new CustomEvent('settingschange', { detail: patch }));
  return cache;
}

/** 以前の版が平文で保存していた秘密の値を片付ける（起動時に1回）。
 *  - GAS のトークン → 暗号化して置き直す
 *  - クラウド音声の APIキー → 消す（キーは GAS のスクリプトプロパティに移す）
 *  戻り値: APIキーを消したら true（利用者に知らせるため） */
export async function migrateSecrets() {
  const s = getSettings();
  let removedCloudKey = false;
  const next = { ...s };
  if (typeof s.gasToken === 'string') {
    if (s.gasToken) next.gasTokenBox = await sealSecret(s.gasToken);
    delete next.gasToken;
  }
  if ('cloudKey' in s) {
    removedCloudKey = Boolean(s.cloudKey);
    delete next.cloudKey;
  }
  if (Object.keys(next).length !== Object.keys(s).length || next.gasTokenBox !== s.gasTokenBox) {
    cache = next;
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch {
      // 保存できない環境でも動作は続ける
    }
  }
  return removedCloudKey;
}

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
