// 端末の声（Web Speech API）。無料・オフラインでも動くが、
// iPhone のブラウザでは画面オフ・アプリ切替で必ず止まる（OSの制約）。
const synth = window.speechSynthesis;

export const speechSupported = () => Boolean(synth && window.SpeechSynthesisUtterance);

/** 日本語の声を取得（読み込みが遅いブラウザ向けに待つ） */
export function getJapaneseVoices(timeout = 1500) {
  if (!speechSupported()) return Promise.resolve([]);
  const pick = () => synth.getVoices().filter((v) => /^ja/i.test(v.lang));
  const now = pick();
  if (now.length) return Promise.resolve(sortVoices(now));
  return new Promise((resolve) => {
    const done = () => {
      synth.removeEventListener?.('voiceschanged', done);
      resolve(sortVoices(pick()));
    };
    synth.addEventListener?.('voiceschanged', done);
    setTimeout(done, timeout);
  });
}

// 品質の高い声を上に（Edge の Natural、iOS の拡張/プレミアム、Google など）
function voiceScore(v) {
  const n = v.name;
  let s = 0;
  if (/Natural|Online/i.test(n)) s += 50;
  if (/Premium|プレミアム/i.test(n)) s += 45;
  if (/Enhanced|拡張/i.test(n)) s += 40;
  if (/Nanami|Keita|Aoi|Daichi|Mayu|Naoki|Shiori/i.test(n)) s += 10;
  if (/Google/i.test(n)) s += 20;
  if (/Kyoko|O-ren|Otoya|Hattori/i.test(n)) s += 5;
  if (v.localService === false) s += 1;
  return s;
}

function sortVoices(list) {
  return [...list].sort((a, b) => voiceScore(b) - voiceScore(a));
}

export class SpeechEngine {
  constructor(host) {
    this.host = host; // { segments, onSegment(i), onEnd(), onError(msg), settings() }
    this.gen = 0;
    this.utter = null; // Chrome は参照を保持しないと onend が来ないことがある
    this.index = 0;
    this.playing = false;
    this.voices = [];
    getJapaneseVoices().then((v) => (this.voices = v));
  }

  get kind() {
    return 'device';
  }

  voice() {
    const name = this.host.settings().deviceVoice;
    const all = synth.getVoices();
    return all.find((v) => v.name === name) || this.voices[0] || all.find((v) => /^ja/i.test(v.lang)) || null;
  }

  /** 指定した文から読み上げる（ユーザー操作の中で同期的に呼ぶこと：iOS の制約） */
  start(index) {
    const gen = ++this.gen;
    this.playing = true;
    const wasBusy = synth.speaking || synth.pending;
    if (wasBusy) synth.cancel();
    // Chrome は cancel 直後の speak を取りこぼすことがあるので少し待つ
    if (wasBusy) setTimeout(() => this.speak(index, gen), 80);
    else this.speak(index, gen);
  }

  speak(index, gen) {
    if (gen !== this.gen) return;
    const segs = this.host.segments;
    // 読み上げる中身がない文（URLだけ等）は飛ばす
    while (index < segs.length && !segs[index].speech) index++;
    if (index >= segs.length) {
      this.playing = false;
      this.host.onEnd();
      return;
    }
    this.index = index;
    this.host.onSegment(index);
    const u = new SpeechSynthesisUtterance(segs[index].speech);
    u.lang = 'ja-JP';
    const v = this.voice();
    if (v) {
      u.voice = v;
      u.lang = v.lang;
    }
    u.rate = this.host.settings().rate;
    u.onend = () => {
      if (gen !== this.gen) return;
      this.speak(index + 1, gen);
    };
    u.onerror = (e) => {
      if (gen !== this.gen) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') {
        this.playing = false;
        this.host.onError('再生がブロックされました。▶ボタンをもう一度押してください');
        return;
      }
      this.speak(index + 1, gen);
    };
    this.utter = u;
    synth.speak(u);
  }

  // pause()/resume() は Android などで不安定なので、止めて同じ文から言い直す方式にする
  pause() {
    this.gen++;
    this.playing = false;
    synth.cancel();
  }

  stop() {
    this.pause();
  }

  setRate() {
    if (this.playing) this.start(this.index);
  }

  /** 画面復帰時：iOS でバックグラウンド後に固まった読み上げを立て直す */
  recover(stalledMs) {
    if (this.playing && (!synth.speaking || stalledMs > 15000)) this.start(this.index);
  }

  destroy() {
    this.stop();
  }
}
