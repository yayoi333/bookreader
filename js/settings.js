// 設定（端末ごとに localStorage に保存）
const KEY = 'yomiage.settings.v1';

export const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/.test(navigator.userAgent);

const DEFAULTS = {
  engine: 'device', // 'device' = 端末の声（無料） / 'cloud' = Google Cloud TTS（音声ファイル化）
  rate: 1.0,
  deviceVoice: '',
  cloudKey: '',
  cloudVoice: 'ja-JP-Chirp3-HD-Aoede',
  fontSize: 18,
  autoScroll: true,
  wakeLock: false,
  keepAlive: isAndroid, // 端末の声の再生中に無音を流して止まりにくくする（実験的）
  gasUrl: '',
  gasToken: '',
  autoSaveDrive: false,
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

export const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
