// クラウド音声（Google Cloud Text-to-Speech）。文章を音声ファイル(MP3)にして <audio> で再生する。
// 音声ファイルの再生なので、スマホで画面オフ・別アプリに移動しても再生が続き、ロック画面から操作できる。
// 無料枠：Chirp 3 HD / Neural2 は毎月100万文字、WaveNet / Standard は毎月400万文字（2026年10月時点の公式料金表）
import { chunkSegments, chunkIndexOf, segmentAtRatio, ratioOfSegment, terminateSoftSplits } from '../text.js';
import { audioCache, kv } from '../db.js';
import { base64ToBlob, sha256Hex, silentWavUrl } from '../audio-util.js';

const API = 'https://texttospeech.googleapis.com/v1';

function apiError(json, status) {
  const m = json?.error?.message || '';
  if (/API key not valid|API_KEY_INVALID/i.test(m)) return 'APIキーが正しくありません';
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(m)) return 'Cloud Text-to-Speech API が有効になっていません';
  if (/billing/i.test(m)) return '請求先アカウントが未設定です（無料枠内でも登録が必要です）';
  if (/referer|referrer/i.test(m)) return 'APIキーの「ウェブサイトの制限」にこのアプリのURLが入っていません';
  if (/voice/i.test(m) && /not|exist|invalid/i.test(m)) return `声の名前が無効です：${m}`;
  if (status === 429) return '短時間に使いすぎました。少し待ってから再生してください';
  return m || `クラウド音声の生成に失敗しました（${status}）`;
}

export async function listCloudVoices(key) {
  const res = await fetch(`${API}/voices?languageCode=ja-JP&key=${encodeURIComponent(key)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(apiError(json, res.status));
  const rank = (n) => (/Chirp3-HD/.test(n) ? 0 : /Chirp-HD/.test(n) ? 1 : /Neural2/.test(n) ? 2 : /Wavenet/.test(n) ? 3 : 4);
  return (json.voices || [])
    .filter((v) => v.languageCodes?.some((l) => /^ja/i.test(l)))
    .map((v) => ({ name: v.name, gender: v.ssmlGender }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export function freeTierFor(voice) {
  return /Wavenet|Standard/i.test(voice) ? 4_000_000 : 1_000_000;
}

export async function synthesize(key, voice, text) {
  const languageCode = voice.split('-').slice(0, 2).join('-') || 'ja-JP';
  const res = await fetch(`${API}/text:synthesize?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voice },
      // 速度は再生側(playbackRate)で変えるので、生成は等速。速度を変えても作り直し不要
      audioConfig: { audioEncoding: 'MP3' },
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(apiError(json, res.status));
    err.status = res.status;
    err.raw = json?.error?.message || '';
    throw err;
  }
  await addUsage(text.length);
  return base64ToBlob(json.audioContent, 'audio/mpeg');
}

const monthKey = () => `usage-${new Date().toISOString().slice(0, 7)}`;

async function addUsage(chars) {
  const k = monthKey();
  await kv.set(k, (await kv.get(k, 0)) + chars);
}

export const monthlyUsage = () => kv.get(monthKey(), 0);

export class CloudEngine {
  constructor(host) {
    this.host = host; // { doc, segments, audio, settings(), onSegment, onEnd, onError, onLoading }
    this.audio = host.audio;
    this.gen = 0;
    this.playing = false;
    this.index = 0;
    this.chunks = null;
    this.chunkKey = '';
    this.blobs = new Map();
    this.urls = new Map();
    this.inflight = new Map();
    this.loadedChunk = null;
    this.unlocked = false;
    this.onTime = () => this.handleTime();
    this.onEnded = () => this.handleEnded();
    this.audio.addEventListener('timeupdate', this.onTime);
    this.audio.addEventListener('ended', this.onEnded);
  }

  get kind() {
    return 'cloud';
  }

  ensureChunks() {
    const key = `${this.host.doc?.id}|${this.host.settings().cloudVoice}|${this.host.segments.length}`;
    if (this.chunkKey === key) return;
    this.reset();
    this.chunkKey = key;
    this.chunks = chunkSegments(this.host.segments);
  }

  reset() {
    for (const u of this.urls.values()) URL.revokeObjectURL(u);
    this.urls.clear();
    this.blobs.clear();
    this.inflight.clear();
    this.loadedChunk = null;
    this.chunks = null;
    this.chunkKey = '';
  }

  /** iOS は「ユーザー操作の中で一度 play() した要素」しか後から鳴らせないので、無音で解錠しておく */
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.loadedChunk = null;
    this.audio.src = silentWavUrl();
    this.audio.play().catch(() => {});
  }

  start(index) {
    const gen = ++this.gen;
    const { cloudKey } = this.host.settings();
    if (!cloudKey) {
      this.host.onError('クラウド音声のAPIキーが未設定です（設定画面）');
      return;
    }
    this.playing = true;
    this.unlock();
    this.ensureChunks();
    const ci = chunkIndexOf(this.chunks, index);
    if (ci < 0) {
      this.playing = false;
      this.host.onEnd();
      return;
    }
    // 同じチャンクを読み込み済みなら、その場で再開（一時停止からの再開は位置そのまま）
    if (this.loadedChunk === ci) {
      if (index !== this.index) this.seekWithin(ci, index);
      this.applyRate();
      this.audio.play().catch(() => this.failPlay(gen));
      return;
    }
    this.index = index;
    this.host.onSegment(index);
    this.host.onLoading(true);
    this.load(ci)
      .then(() => {
        if (gen !== this.gen) return;
        this.host.onLoading(false);
        this.playChunk(ci, index, gen);
        this.prefetch(ci + 1);
      })
      .catch((err) => {
        if (gen !== this.gen) return;
        this.playing = false;
        this.host.onLoading(false);
        this.host.onError(err.message);
      });
  }

  playChunk(ci, segIndex, gen) {
    const chunk = this.chunks[ci];
    let url = this.urls.get(ci);
    if (!url) {
      url = URL.createObjectURL(this.blobs.get(ci));
      this.urls.set(ci, url);
    }
    this.loadedChunk = ci;
    this.audio.src = url;
    this.applyRate();
    if (segIndex > chunk.start) {
      const ratio = ratioOfSegment(chunk, segIndex);
      this.audio.addEventListener(
        'loadedmetadata',
        () => {
          if (Number.isFinite(this.audio.duration)) this.audio.currentTime = ratio * this.audio.duration;
        },
        { once: true },
      );
    }
    this.audio.play().catch(() => this.failPlay(gen));
  }

  failPlay(gen) {
    if (gen !== this.gen) return;
    this.playing = false;
    this.host.onError('再生できませんでした。▶ボタンをもう一度押してください');
  }

  seekWithin(ci, index) {
    const ratio = ratioOfSegment(this.chunks[ci], index);
    if (Number.isFinite(this.audio.duration)) this.audio.currentTime = ratio * this.audio.duration;
    this.index = index;
    this.host.onSegment(index);
  }

  applyRate() {
    const r = this.host.settings().rate;
    this.audio.defaultPlaybackRate = r;
    this.audio.playbackRate = r;
    if ('preservesPitch' in this.audio) this.audio.preservesPitch = true;
  }

  handleTime() {
    if (!this.playing || this.loadedChunk === null) return;
    const d = this.audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const idx = segmentAtRatio(this.chunks[this.loadedChunk], this.audio.currentTime / d);
    if (idx !== this.index) {
      this.index = idx;
      this.host.onSegment(idx);
    }
  }

  handleEnded() {
    if (!this.playing || this.loadedChunk === null) return;
    const next = this.loadedChunk + 1;
    const gen = this.gen;
    if (next >= this.chunks.length) {
      this.playing = false;
      this.loadedChunk = null;
      this.host.onEnd();
      return;
    }
    this.index = this.chunks[next].start;
    this.host.onSegment(this.index);
    if (this.blobs.has(next)) {
      this.playChunk(next, this.chunks[next].start, gen);
    } else {
      this.host.onLoading(true);
      this.load(next)
        .then(() => {
          if (gen !== this.gen) return;
          this.host.onLoading(false);
          this.playChunk(next, this.chunks[next].start, gen);
        })
        .catch((err) => {
          if (gen !== this.gen) return;
          this.playing = false;
          this.host.onLoading(false);
          this.host.onError(err.message);
        });
    }
    this.prefetch(next + 1);
  }

  /** 残りを順番に先読み（画面オフ中に生成待ちで止まらないよう、再生開始直後から全部作る） */
  async prefetch(from) {
    if (this.prefetching) return;
    this.prefetching = true;
    const chunks = this.chunks;
    try {
      for (let c = from; c < chunks.length; c++) {
        if (this.chunks !== chunks) break;
        await this.load(c).catch(() => {});
      }
    } finally {
      this.prefetching = false;
    }
  }

  load(ci) {
    if (this.blobs.has(ci)) return Promise.resolve(this.blobs.get(ci));
    if (this.inflight.has(ci)) return this.inflight.get(ci);
    const chunks = this.chunks;
    const chunk = chunks[ci];
    const { cloudKey, cloudVoice } = this.host.settings();
    const p = (async () => {
      const key = await sha256Hex(`${cloudVoice}\n${chunk.text}`);
      let blob = await audioCache.get(key);
      if (!blob) {
        try {
          blob = await synthesize(cloudKey, cloudVoice, chunk.text);
        } catch (e) {
          // 読点で切った長い文が「文が長すぎる」と言われたら句点を補って再試行
          if (e.status === 400 && /too long|sentence/i.test(e.raw)) {
            blob = await synthesize(cloudKey, cloudVoice, terminateSoftSplits(chunk));
          } else {
            throw e;
          }
        }
        await audioCache.put(key, blob).catch(() => {});
      }
      if (this.chunks === chunks) this.blobs.set(ci, blob);
      return blob;
    })();
    this.inflight.set(ci, p);
    p.finally(() => this.inflight.delete(ci)).catch(() => {});
    return p;
  }

  /** 生成済みのチャンク数（進捗表示用） */
  readyCount() {
    return this.blobs.size;
  }

  pause() {
    this.gen++;
    this.playing = false;
    this.audio.pause();
  }

  stop() {
    this.pause();
    this.loadedChunk = null;
  }

  setRate() {
    this.applyRate();
  }

  recover() {}

  destroy() {
    this.stop();
    this.audio.removeEventListener('timeupdate', this.onTime);
    this.audio.removeEventListener('ended', this.onEnded);
    this.reset();
  }
}
