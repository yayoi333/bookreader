// 再生の司令塔：読み上げ方式の切替・ロック画面の操作・続きから再生・画面消灯防止
import { buildSegments } from './text.js';
import { SpeechEngine } from './engines/speech.js';
import { CloudEngine } from './engines/cloud.js';
import { getSettings, saveSettings } from './settings.js';
import { docs } from './db.js';
import { silentWavUrl } from './audio-util.js';

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.setAttribute('playsinline', '');
    this.keepAliveEl = new Audio();
    this.keepAliveEl.loop = true;
    this.doc = null;
    this.segments = [];
    this.index = 0;
    this.playing = false;
    this.loading = false;
    this.engine = null;
    this.lastSegAt = 0;
    this.wakeLock = null;
    this.saveTimer = null;
    document.addEventListener('visibilitychange', () => this.onVisibility());
    window.addEventListener('settingschange', (e) => {
      if ('engine' in e.detail || 'cloudVoice' in e.detail || 'deviceVoice' in e.detail) this.resetEngine();
    });
    this.setupMediaSession();
  }

  settings() {
    return getSettings();
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  load(doc) {
    if (this.doc && this.doc.id === doc.id && this.doc.updatedAt === doc.updatedAt) {
      this.doc = doc;
      return;
    }
    this.stop();
    this.engine?.destroy();
    this.engine = null;
    this.doc = doc;
    this.segments = buildSegments(doc.blocks);
    const saved = doc.progress || 0;
    this.index = saved >= this.segments.length ? 0 : saved;
    this.updateMetadata();
    this.emit('load');
    this.emit('position');
  }

  get finished() {
    return this.segments.length > 0 && this.index >= this.segments.length;
  }

  getEngine() {
    const kind = getSettings().engine === 'cloud' ? 'cloud' : 'device';
    if (!this.engine || this.engine.kind !== kind) {
      this.engine?.destroy();
      this.engine = kind === 'cloud' ? new CloudEngine(this) : new SpeechEngine(this);
    }
    return this.engine;
  }

  resetEngine() {
    if (this.playing || this.loading) this.pause();
    this.engine?.destroy();
    this.engine = null;
    this.emit('state');
  }

  /** ▶ ボタンのクリック処理の中から同期的に呼ぶこと（iOS の再生許可のため） */
  play(index = this.index) {
    if (!this.doc || !this.segments.length) return;
    if (index >= this.segments.length) index = 0;
    const engine = this.getEngine();
    this.playing = true;
    this.index = index;
    this.lastSegAt = Date.now();
    if (engine.kind === 'device') this.startKeepAlive();
    this.requestWakeLock();
    engine.start(index);
    this.setPlaybackState('playing');
    this.emit('state');
  }

  pause() {
    this.playing = false;
    this.loading = false;
    this.engine?.pause();
    this.stopKeepAlive();
    this.releaseWakeLock();
    this.saveProgress(true);
    this.setPlaybackState('paused');
    this.emit('state');
  }

  toggle() {
    if (this.playing || this.loading) this.pause();
    else this.play();
  }

  stop() {
    if (this.playing || this.loading) this.pause();
    this.engine?.stop();
  }

  seek(index) {
    if (!this.segments.length) return;
    index = Math.max(0, Math.min(this.segments.length - 1, index));
    this.index = index;
    this.emit('position');
    if (this.playing) this.engine.start(index);
    else this.saveProgress();
  }

  next() {
    let i = this.index + 1;
    while (i < this.segments.length - 1 && !this.segments[i].speech) i++;
    this.seek(i);
  }

  prev() {
    let i = this.index - 1;
    while (i > 0 && !this.segments[i].speech) i--;
    this.seek(i);
  }

  setRate(rate) {
    saveSettings({ rate });
    this.engine?.setRate(rate);
    this.emit('rate');
  }

  // ---- エンジンからの通知 ----
  onSegment(i) {
    this.index = i;
    this.lastSegAt = Date.now();
    this.emit('position');
    this.saveProgress();
  }

  onEnd() {
    this.playing = false;
    this.loading = false;
    this.index = this.segments.length;
    this.stopKeepAlive();
    this.releaseWakeLock();
    this.saveProgress(true);
    this.setPlaybackState('none');
    this.emit('position');
    this.emit('state');
    this.emit('ended');
  }

  onError(message) {
    this.playing = false;
    this.loading = false;
    this.stopKeepAlive();
    this.setPlaybackState('paused');
    this.emit('state');
    this.emit('error', message);
  }

  onLoading(v) {
    this.loading = v;
    this.emit('state');
  }

  // ---- 進み具合の保存 ----
  saveProgress(now = false) {
    if (!this.doc) return;
    clearTimeout(this.saveTimer);
    const id = this.doc.id;
    const index = this.index;
    const write = () => docs.setProgress(id, index).catch(() => {});
    if (now) write();
    else this.saveTimer = setTimeout(write, 1500);
  }

  // ---- ロック画面・通知の操作 ----
  setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const set = (action, fn) => {
      try {
        navigator.mediaSession.setActionHandler(action, fn);
      } catch {
        // 未対応のアクションは無視
      }
    };
    set('play', () => this.play());
    set('pause', () => this.pause());
    set('stop', () => this.pause());
    set('previoustrack', () => this.prev());
    set('nexttrack', () => this.next());
  }

  updateMetadata() {
    if (!('mediaSession' in navigator) || !this.doc || typeof MediaMetadata === 'undefined') return;
    let host = '';
    try {
      host = this.doc.url ? new URL(this.doc.url).hostname : '';
    } catch {
      host = '';
    }
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.doc.title,
      artist: this.doc.author || host || 'よみあげ文庫',
      album: 'よみあげ文庫',
      artwork: [{ src: new URL('icons/icon-512.png', document.baseURI).href, sizes: '512x512', type: 'image/png' }],
    });
  }

  setPlaybackState(state) {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
  }

  // ---- 端末の声を止まりにくくする工夫（実験的） ----
  startKeepAlive() {
    if (!getSettings().keepAlive) return;
    if (!this.keepAliveEl.src) this.keepAliveEl.src = silentWavUrl();
    this.keepAliveEl.play().catch(() => {});
  }

  stopKeepAlive() {
    this.keepAliveEl.pause();
  }

  async requestWakeLock() {
    if (!getSettings().wakeLock || !('wakeLock' in navigator) || this.wakeLock) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
      this.wakeLock.addEventListener('release', () => (this.wakeLock = null));
    } catch {
      this.wakeLock = null;
    }
  }

  releaseWakeLock() {
    this.wakeLock?.release().catch(() => {});
    this.wakeLock = null;
  }

  onVisibility() {
    if (document.visibilityState !== 'visible') return;
    if (this.playing) {
      this.requestWakeLock();
      this.engine?.recover(Date.now() - this.lastSegAt);
    }
    this.emit('state');
  }
}
