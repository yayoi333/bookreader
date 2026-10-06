import { docs, newId, audioCache } from './db.js';
import { buildSegments, blocksFromPlainText } from './text.js';
import { importFromInput, docFromPageHtml } from './extract.js';
import { drive, driveConfigured } from './drive.js';
import { Player } from './player.js';
import { getSettings, saveSettings, RATES, isIOS, isAndroid } from './settings.js';
import { getJapaneseVoices, speechSupported } from './engines/speech.js';
import { listCloudVoices, monthlyUsage, freeTierFor } from './engines/cloud.js';

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const player = new Player();
const APP_URL = new URL('./', location.href).href;
export const APP_VERSION = '0.1.2';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h2v12H6zM20 6v12l-9-6z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 6h2v12h-2zM4 6v12l9-6z" fill="currentColor"/></svg>',
  spin: '<svg viewBox="0 0 24 24" class="spin" aria-hidden="true"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="36 60" stroke-linecap="round"/></svg>',
};

const SOURCE_LABEL = { x: 'X', web: 'Web', text: 'メモ', drive: 'Drive' };

// ---------------------------------------------------------------- 共通UI

let toastTimer;
function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function setBusy(on, msg = '取り込み中…') {
  const el = $('#busy');
  el.hidden = !on;
  $('#busy-msg').textContent = msg;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function applyFontSize() {
  document.documentElement.style.setProperty('--reader-size', `${getSettings().fontSize}px`);
}

// ---------------------------------------------------------------- インストール（Androidの共有メニューに出すために必要）

let installPrompt = null;
const isInstalled = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: minimal-ui)').matches;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  refreshInstallUi();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  toast('インストールしました。Xアプリの共有メニューに「よみあげ文庫」が出ます');
  refreshInstallUi();
});

function installBoxHtml() {
  if (isIOS || isInstalled()) return '';
  return `
    <section class="card install" id="install-box">
      <h2>アプリとしてインストール</h2>
      <p class="hint">Xアプリの共有メニューに出すには、ショートカットではなく<b>インストール</b>が必要です。</p>
      <div class="row">
        <button id="install-btn" class="primary" ${installPrompt ? '' : 'hidden'}>インストールする</button>
        <span id="install-wait" class="hint" ${installPrompt ? 'hidden' : ''}>
          ボタンが出ないときは、Chrome右上の「︙」→「ホーム画面に追加」→「<b>インストール</b>」を選んでください（「ショートカットを作成」ではありません）。</span>
      </div>
    </section>`;
}

function refreshInstallUi() {
  const btn = $('#install-btn');
  if (btn) {
    btn.hidden = !installPrompt;
    $('#install-wait').hidden = Boolean(installPrompt);
    btn.onclick = async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice.catch(() => null);
      installPrompt = null;
      refreshInstallUi();
    };
  }
  if (isInstalled()) $('#install-box')?.remove();
}

// ---------------------------------------------------------------- 取り込み

async function saveImported(doc, { forceDrive = false } = {}) {
  const existing = doc.url ? await docs.findBy('url', doc.url) : null;
  let saved;
  if (existing) {
    saved = { ...existing, title: doc.title, author: doc.author, blocks: doc.blocks, updatedAt: Date.now() };
    if (JSON.stringify(existing.blocks) !== JSON.stringify(doc.blocks)) saved.progress = 0;
  } else {
    saved = { ...doc, id: newId(), createdAt: Date.now(), updatedAt: Date.now(), progress: 0 };
  }
  await docs.put(saved);
  if (driveConfigured() && !saved.driveFileId && (forceDrive || getSettings().autoSaveDrive)) {
    saveToDrive(saved, { quiet: true });
  }
  return saved;
}

async function saveToDrive(doc, { quiet = false } = {}) {
  try {
    const res = await drive.save(doc);
    const latest = (await docs.get(doc.id)) || doc;
    await docs.put({ ...latest, driveFileId: res.id, driveUrl: res.url, updatedAt: latest.updatedAt });
    toast(quiet ? 'Driveにも保存しました' : 'Driveに保存しました');
    if (location.hash === `#/doc/${doc.id}`) route();
  } catch (e) {
    toast(`Drive保存に失敗：${e.message}`, 5000);
  }
}

async function importAndOpen(input, opts = {}) {
  setBusy(true);
  try {
    const doc = await importFromInput(input, opts);
    const saved = await saveImported(doc, opts);
    location.hash = `#/doc/${saved.id}`;
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    setBusy(false);
  }
}

/** ブックマークレットから開かれたとき、元ページのHTMLを受け取る */
function receiveFromBookmarklet() {
  return new Promise((resolve) => {
    if (!window.opener) return resolve(null);
    let tries = 0;
    const onMsg = (e) => {
      if (e.data && e.data.type === 'yomiage-page' && typeof e.data.html === 'string') {
        cleanup();
        resolve(e.data);
      }
    };
    const timer = setInterval(() => {
      if (++tries > 25) {
        cleanup();
        resolve(null);
        return;
      }
      try {
        window.opener.postMessage({ type: 'yomiage-ready' }, '*');
      } catch {
        // opener が閉じられた
      }
    }, 200);
    const cleanup = () => {
      clearInterval(timer);
      window.removeEventListener('message', onMsg);
    };
    window.addEventListener('message', onMsg);
  });
}

async function handleIncoming() {
  const p = new URLSearchParams(location.search);
  if (![...p.keys()].length) return;
  const fromBookmarklet = p.get('from') === 'bm';
  // 共有ターゲット(Android)は title/text/url、ショートカット(iPhone)は q で受け取る
  const input = p.get('q') || [p.get('url'), p.get('text')].filter(Boolean).join(' ');
  const opts = { title: p.get('title') || undefined, forceDrive: p.get('save') === '1' };
  history.replaceState(null, '', location.pathname + (location.hash || '#/'));
  if (fromBookmarklet) {
    setBusy(true, 'ページを受け取り中…');
    const data = await receiveFromBookmarklet();
    if (!data) {
      setBusy(false);
      toast('ページを受け取れませんでした。もう一度ブックマークレットを押してください', 6000);
      return;
    }
    try {
      const doc = docFromPageHtml(data.html, data.url, { selection: data.selection });
      if (!doc.title || doc.title === 'メモ') doc.title = data.title || doc.title;
      const saved = await saveImported(doc, opts);
      location.hash = `#/doc/${saved.id}`;
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      setBusy(false);
    }
    return;
  }
  if (input.trim()) await importAndOpen(input, opts);
}

// ---------------------------------------------------------------- 画面：本棚

async function renderLibrary() {
  const list = await docs.all();
  view.innerHTML = `${installBoxHtml()}
    <section class="card import">
      <label for="import-input" class="label">XのURL・記事のURL・テキストを貼り付け</label>
      <textarea id="import-input" rows="3" placeholder="https://x.com/…/status/…"></textarea>
      <div class="row end">
        <button id="paste-btn" class="ghost">クリップボードから</button>
        <button id="import-btn" class="primary">取り込む</button>
      </div>
    </section>
    <section>
      <h2 class="section-title">本棚 <span class="count">${list.length}</span></h2>
      ${
        list.length
          ? `<ul class="doc-list">${list.map(docItem).join('')}</ul>`
          : `<p class="empty">まだ何もありません。上の欄にXの記事やWeb記事のURLを貼るか、
             <a href="#/help">使い方</a>のショートカット／ブックマークレットで送ってください。</p>`
      }
    </section>`;
  refreshInstallUi();
  $('#import-btn').onclick = () => {
    const v = $('#import-input').value;
    if (v.trim()) importAndOpen(v);
  };
  $('#paste-btn').onclick = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return toast('クリップボードが空です');
      $('#import-input').value = t;
      importAndOpen(t);
    } catch {
      toast('クリップボードを読めませんでした。欄に長押しで貼り付けてください');
    }
  };
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const doc = await docs.get(b.dataset.del);
      if (!doc || !confirm(`「${doc.title}」を本棚から削除しますか？（Driveのファイルは残ります）`)) return;
      if (player.doc?.id === doc.id) {
        player.stop();
        player.doc = null;
        updatePlayerBar();
      }
      await docs.delete(doc.id);
      renderLibrary();
    };
  });
}

function docItem(d) {
  const total = buildSegments(d.blocks).length || 1;
  const pct = Math.min(100, Math.round(((d.progress || 0) / total) * 100));
  const meta = [SOURCE_LABEL[d.source] || '', d.author || hostOf(d.url), fmtDate(d.createdAt)].filter(Boolean).join(' · ');
  return `
    <li>
      <a class="doc-item" href="#/doc/${esc(d.id)}">
        <span class="doc-title">${esc(d.title)}</span>
        <span class="doc-meta">${esc(meta)}${d.driveFileId ? ' · <span class="badge">Drive</span>' : ''}</span>
        <span class="bar"><span style="width:${pct}%"></span></span>
      </a>
      <button class="icon-btn del" data-del="${esc(d.id)}" aria-label="削除" title="削除">×</button>
    </li>`;
}

// ---------------------------------------------------------------- 画面：読む

async function renderReader(id) {
  const doc = await docs.get(id);
  if (!doc) {
    view.innerHTML = '<p class="empty">見つかりませんでした。<a href="#/">本棚へ</a></p>';
    return;
  }
  player.load(doc);
  const segs = player.segments;
  let html = '';
  let listOpen = false;
  doc.blocks.forEach((b, bi) => {
    const spans = [];
    segs.forEach((s, i) => {
      if (s.block === bi) spans.push(`<span class="seg" data-i="${i}">${esc(s.text)}</span>`);
    });
    const inner = spans.join('');
    if (b.type === 'li' && !listOpen) {
      html += '<ul>';
      listOpen = true;
    }
    if (b.type !== 'li' && listOpen) {
      html += '</ul>';
      listOpen = false;
    }
    if (b.type === 'h') html += `<h2>${inner}</h2>`;
    else if (b.type === 'li') html += `<li>${inner}</li>`;
    else if (b.type === 'quote') html += `<blockquote>${inner}</blockquote>`;
    else html += `<p>${inner}</p>`;
  });
  if (listOpen) html += '</ul>';

  const meta = [doc.author, fmtDate(doc.publishedAt || doc.createdAt)].filter(Boolean).map(esc).join(' · ');
  view.innerHTML = `
    <article class="reader">
      <header class="reader-head">
        <h1>${esc(doc.title)}</h1>
        <p class="doc-meta">${meta}${doc.url ? ` · <a href="${esc(doc.url)}" target="_blank" rel="noopener">元のページ</a>` : ''}</p>
        <div class="row">
          <button id="read-btn" class="primary">${ICONS.play}<span>${player.index > 0 && !player.finished ? '続きから聞く' : '最初から聞く'}</span></button>
          ${
            doc.driveFileId
              ? `<a class="ghost btn" href="${esc(doc.driveUrl)}" target="_blank" rel="noopener">Driveで開く</a>`
              : `<button id="drive-btn" class="ghost">Driveに保存</button>`
          }
        </div>
      </header>
      <div class="reader-body">${html || '<p class="empty">本文がありません</p>'}</div>
    </article>`;
  $('#read-btn').onclick = () => player.play(player.finished ? 0 : player.index);
  const driveBtn = $('#drive-btn');
  if (driveBtn) {
    driveBtn.onclick = () => {
      if (!driveConfigured()) {
        toast('先に設定画面でDrive連携を設定してください', 4000);
        location.hash = '#/settings';
        return;
      }
      driveBtn.disabled = true;
      driveBtn.textContent = '保存中…';
      saveToDrive(doc);
    };
  }
  $('.reader-body').onclick = (e) => {
    const seg = e.target.closest('.seg');
    if (!seg || String(window.getSelection()).length) return;
    const i = Number(seg.dataset.i);
    if (player.playing || player.loading) player.seek(i);
    else player.play(i);
  };
  highlight(true);
  updatePlayerBar();
}

let lastHighlighted = null;
function highlight(scroll) {
  const el = view.querySelector(`.seg[data-i="${player.index}"]`);
  if (lastHighlighted && lastHighlighted !== el) lastHighlighted.classList.remove('current');
  if (!el) return;
  el.classList.add('current');
  lastHighlighted = el;
  if (scroll && getSettings().autoScroll && document.visibilityState === 'visible') {
    const r = el.getBoundingClientRect();
    const bottomLimit = window.innerHeight - ($('#player').offsetHeight || 0) - 40;
    if (r.top < 70 || r.bottom > bottomLimit) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

// ---------------------------------------------------------------- 再生バー

function setupPlayerBar() {
  const rateSel = $('#p-rate');
  rateSel.innerHTML = RATES.map((r) => `<option value="${r}">${r}x</option>`).join('');
  rateSel.value = String(getSettings().rate);
  rateSel.onchange = () => player.setRate(Number(rateSel.value));
  $('#p-play').onclick = () => player.toggle();
  $('#p-prev').onclick = () => player.prev();
  $('#p-next').onclick = () => player.next();
  $('#p-prev').innerHTML = ICONS.prev;
  $('#p-next').innerHTML = ICONS.next;
  $('#p-title').onclick = () => player.doc && (location.hash = `#/doc/${player.doc.id}`);
  $('#p-seek').oninput = (e) => player.seek(Number(e.target.value));

  player.addEventListener('position', () => {
    updatePlayerBar();
    highlight(player.playing);
  });
  player.addEventListener('state', updatePlayerBar);
  player.addEventListener('load', updatePlayerBar);
  player.addEventListener('rate', () => (rateSel.value = String(getSettings().rate)));
  player.addEventListener('error', (e) => toast(e.detail, 6000));
  player.addEventListener('ended', () => toast('最後まで読みました'));
}

function updatePlayerBar() {
  const bar = $('#player');
  const has = Boolean(player.doc);
  bar.hidden = !has;
  document.body.classList.toggle('has-player', has);
  if (!has) return;
  const total = player.segments.length;
  const cur = Math.min(player.index + 1, total);
  $('#p-title').textContent = player.doc.title;
  $('#p-play').innerHTML = player.loading ? ICONS.spin : player.playing ? ICONS.pause : ICONS.play;
  $('#p-play').setAttribute('aria-label', player.playing ? '一時停止' : '再生');
  $('#p-pos').textContent = player.finished ? '読了' : `${cur} / ${total} 文`;
  const seek = $('#p-seek');
  seek.max = String(Math.max(0, total - 1));
  if (document.activeElement !== seek) seek.value = String(Math.min(player.index, total - 1));
  const s = getSettings();
  $('#p-engine').textContent = s.engine === 'cloud' ? 'クラウド音声' : '端末の声';
}

// ---------------------------------------------------------------- 画面：設定

async function renderSettings() {
  const s = getSettings();
  const usage = await monthlyUsage().catch(() => 0);
  const cacheBytes = await audioCache.size().catch(() => 0);
  const free = freeTierFor(s.cloudVoice);
  view.innerHTML = `
    <h1 class="page-title">設定</h1>

    <section class="card">
      <h2>読み上げ方式</h2>
      <label class="radio"><input type="radio" name="engine" value="device" ${s.engine !== 'cloud' ? 'checked' : ''}>
        <span><b>端末の声</b>（完全無料・設定不要）<br><small>${
          isIOS
            ? 'iPhoneでは画面を消す・他のアプリに移ると止まります（iOSの制約）'
            : 'パソコンはバックグラウンドでもOK。Androidは機種によって画面オフで止まることがあります'
        }</small></span></label>
      <label class="radio"><input type="radio" name="engine" value="cloud" ${s.engine === 'cloud' ? 'checked' : ''}>
        <span><b>クラウド音声</b>（Google・無料枠あり）<br><small>音声ファイルにして再生するので、画面オフ・別アプリでも止まりません。声も自然です</small></span></label>
    </section>

    <section class="card">
      <h2>端末の声</h2>
      <label class="label" for="device-voice">声</label>
      <div class="row"><select id="device-voice"><option value="">（自動で一番良い声）</option></select>
      <button id="device-test" class="ghost">試聴</button></div>
      <p class="hint">${
        isIOS
          ? '「設定 → アクセシビリティ → 読み上げコンテンツ → 声 → 日本語」で「拡張」や「プレミアム」の声をダウンロードすると、かなり自然になります。'
          : 'パソコンは Microsoft Edge だと「Nanami (Natural)」など自然な声が無料で使えます。'
      }</p>
      <label class="check"><input type="checkbox" id="keep-alive" ${s.keepAlive ? 'checked' : ''}>
        バックグラウンド維持（実験的・Android向け）：無音を流して止まりにくくする</label>
    </section>

    <section class="card">
      <h2>クラウド音声（Google Cloud Text-to-Speech）</h2>
      <label class="label" for="cloud-key">APIキー</label>
      <input id="cloud-key" type="password" autocomplete="off" value="${esc(s.cloudKey)}" placeholder="AIza…">
      <label class="label" for="cloud-voice">声</label>
      <div class="row">
        <select id="cloud-voice"><option value="${esc(s.cloudVoice)}">${esc(s.cloudVoice)}</option></select>
        <button id="cloud-voices" class="ghost">声の一覧を取得</button>
      </div>
      <p class="hint">今月の使用量（この端末）：<b>${usage.toLocaleString()}</b> 文字 / 無料枠 ${(free / 10000).toLocaleString()}万文字
        <br>Chirp3-HD・Neural2 は月100万字、Wavenet・Standard は月400万字まで無料（日本語の長文記事でおよそ100本／400本）。
        一度作った音声は端末に保存され、聞き直しても文字数は増えません。</p>
      <div class="row"><span class="hint">音声キャッシュ：${(cacheBytes / 1024 / 1024).toFixed(1)} MB</span>
        <button id="cache-clear" class="ghost">削除</button></div>
    </section>

    <section class="card">
      <h2>Google Drive 連携</h2>
      <label class="label" for="gas-url">GAS ウェブアプリのURL</label>
      <input id="gas-url" type="url" value="${esc(s.gasUrl)}" placeholder="https://script.google.com/macros/s/…/exec">
      <label class="label" for="gas-token">トークン</label>
      <input id="gas-token" type="password" autocomplete="off" value="${esc(s.gasToken)}">
      <label class="check"><input type="checkbox" id="auto-drive" ${s.autoSaveDrive ? 'checked' : ''}> 取り込んだらDriveにも自動保存</label>
      <div class="row"><button id="gas-test" class="ghost">接続テスト</button></div>
      <p class="hint">設定方法は <a href="#/help">使い方</a> の「Drive連携」を参照。Web記事の取り込み（URLから本文を取得）にも使います。</p>
    </section>

    <section class="card">
      <h2>表示</h2>
      <label class="label" for="font-size">文字の大きさ：<span id="font-size-val">${s.fontSize}</span>px</label>
      <input id="font-size" type="range" min="14" max="28" step="1" value="${s.fontSize}">
      <label class="check"><input type="checkbox" id="auto-scroll" ${s.autoScroll ? 'checked' : ''}> 読んでいる文に自動でスクロール</label>
      <label class="check"><input type="checkbox" id="wake-lock" ${s.wakeLock ? 'checked' : ''}> 再生中は画面を消さない</label>
    </section>`;

  view.querySelectorAll('input[name=engine]').forEach((r) => {
    r.onchange = () => saveSettings({ engine: r.value });
  });

  const dv = $('#device-voice');
  if (speechSupported()) {
    const voices = await getJapaneseVoices();
    dv.innerHTML += voices.map((v) => `<option value="${esc(v.name)}">${esc(v.name)}</option>`).join('');
    dv.value = s.deviceVoice;
    if (!voices.length) dv.insertAdjacentHTML('afterend', '<p class="hint">日本語の声が見つかりません</p>');
  }
  dv.onchange = () => saveSettings({ deviceVoice: dv.value });
  $('#device-test').onclick = () => {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance('こんにちは。よみあげ文庫で、記事を読み上げます。');
    const v = speechSynthesis.getVoices().find((x) => x.name === dv.value);
    if (v) u.voice = v;
    u.lang = v?.lang || 'ja-JP';
    u.rate = getSettings().rate;
    speechSynthesis.speak(u);
  };
  $('#keep-alive').onchange = (e) => saveSettings({ keepAlive: e.target.checked });

  $('#cloud-key').onchange = (e) => saveSettings({ cloudKey: e.target.value.trim() });
  const cv = $('#cloud-voice');
  cv.onchange = () => saveSettings({ cloudVoice: cv.value });
  $('#cloud-voices').onclick = async () => {
    const key = $('#cloud-key').value.trim();
    if (!key) return toast('先にAPIキーを入力してください');
    saveSettings({ cloudKey: key });
    try {
      const voices = await listCloudVoices(key);
      cv.innerHTML = voices
        .map((v) => `<option value="${esc(v.name)}">${esc(v.name)}（${v.gender === 'FEMALE' ? '女性' : v.gender === 'MALE' ? '男性' : '—'}）</option>`)
        .join('');
      cv.value = voices.some((v) => v.name === s.cloudVoice) ? s.cloudVoice : voices[0]?.name || '';
      saveSettings({ cloudVoice: cv.value });
      toast(`${voices.length}種類の声が見つかりました`);
    } catch (e) {
      toast(e.message, 6000);
    }
  };
  $('#cache-clear').onclick = async () => {
    await audioCache.clear();
    toast('音声キャッシュを削除しました');
    renderSettings();
  };

  $('#gas-url').onchange = (e) => saveSettings({ gasUrl: e.target.value.trim() });
  $('#gas-token').onchange = (e) => saveSettings({ gasToken: e.target.value.trim() });
  $('#auto-drive').onchange = (e) => saveSettings({ autoSaveDrive: e.target.checked });
  $('#gas-test').onclick = async () => {
    saveSettings({ gasUrl: $('#gas-url').value.trim(), gasToken: $('#gas-token').value.trim() });
    try {
      const r = await drive.ping();
      toast(`接続OK：Driveのフォルダ「${r.folder}」に保存します`);
    } catch (e) {
      toast(e.message, 6000);
    }
  };

  $('#font-size').oninput = (e) => {
    saveSettings({ fontSize: Number(e.target.value) });
    $('#font-size-val').textContent = e.target.value;
    applyFontSize();
  };
  $('#auto-scroll').onchange = (e) => saveSettings({ autoScroll: e.target.checked });
  $('#wake-lock').onchange = (e) => saveSettings({ wakeLock: e.target.checked });
}

// ---------------------------------------------------------------- 画面：Drive

async function renderDrive() {
  if (!driveConfigured()) {
    view.innerHTML = `<h1 class="page-title">Drive</h1>
      <p class="empty">Drive連携が未設定です。<a href="#/help">使い方</a>の手順でGASを用意し、<a href="#/settings">設定</a>に入力してください。</p>`;
    return;
  }
  view.innerHTML = `<h1 class="page-title">Drive</h1>
    <div class="row"><input id="drive-q" type="search" placeholder="ファイル名で検索（空欄なら「よみあげ文庫」フォルダ）">
    <button id="drive-search" class="primary">表示</button></div>
    <ul id="drive-list" class="doc-list"><li class="empty">読み込み中…</li></ul>`;
  const load = async () => {
    const ul = $('#drive-list');
    ul.innerHTML = '<li class="empty">読み込み中…</li>';
    try {
      const { files } = await drive.list($('#drive-q').value.trim());
      ul.innerHTML = files.length
        ? files
            .map(
              (f) => `<li><button class="doc-item" data-id="${esc(f.id)}">
                <span class="doc-title">${esc(f.name)}</span>
                <span class="doc-meta">${esc(fmtDate(f.updated))}</span></button></li>`,
            )
            .join('')
        : '<li class="empty">ファイルがありません（Googleドキュメント・テキストファイルが対象）</li>';
      ul.querySelectorAll('[data-id]').forEach((b) => (b.onclick = () => openDriveFile(b.dataset.id)));
    } catch (e) {
      ul.innerHTML = `<li class="empty">${esc(e.message)}</li>`;
    }
  };
  $('#drive-search').onclick = load;
  $('#drive-q').onkeydown = (e) => e.key === 'Enter' && load();
  load();
}

async function openDriveFile(id) {
  const existing = await docs.findBy('driveFileId', id);
  setBusy(true, 'Driveから読み込み中…');
  try {
    const f = await drive.get(id);
    const blocks = f.blocks?.length ? f.blocks : blocksFromPlainText(f.text);
    const doc = existing
      ? { ...existing, title: f.title, blocks, updatedAt: Date.now() }
      : {
          id: newId(), title: f.title, url: f.sourceUrl || '', author: '', source: 'drive', blocks,
          driveFileId: id, driveUrl: f.url, createdAt: Date.now(), updatedAt: Date.now(), progress: 0,
        };
    await docs.put(doc);
    location.hash = `#/doc/${doc.id}`;
  } catch (e) {
    toast(e.message, 6000);
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------- 画面：使い方

function bookmarkletCode() {
  const js = `(()=>{const A=${JSON.stringify(APP_URL)};const u=location.href;if(/(^|\\.)(x|twitter)\\.com$/.test(location.hostname)){window.open(A+'?url='+encodeURIComponent(u));return}const w=window.open(A+'?from=bm');if(!w){alert('ポップアップを許可してください');return}const o=new URL(A).origin;const h=e=>{if(e.source!==w||!e.data||e.data.type!=='yomiage-ready')return;removeEventListener('message',h);w.postMessage({type:'yomiage-page',url:u,title:document.title,html:document.documentElement.outerHTML,selection:String(getSelection())},o)};addEventListener('message',h)})()`;
  return 'javascript:' + encodeURIComponent(js);
}

function renderHelp() {
  const bm = bookmarkletCode();
  const shortcutUrl = `${APP_URL}?q=`;
  const userscriptUrl = new URL('userscript/yomiage-x.user.js', APP_URL).href;
  view.innerHTML = `
    <h1 class="page-title">使い方</h1>

    <section class="card">
      <h2>基本</h2>
      <ol>
        <li>本棚の入力欄に <b>XのポストやX記事のURL</b>、Web記事のURL、またはテキストを貼って「取り込む」。</li>
        <li>開いた画面で ▶。<b>文をタップ</b>するとそこから読みます。速度は再生バー右の「1x」。</li>
        <li>途中でやめても、次に開くと<b>続きから</b>読めます。</li>
      </ol>
      <p class="hint">画面を消しても読み続けてほしいときは、設定で「クラウド音声」にしてください（iPhoneは必須）。</p>
    </section>

    <section class="card">
      <h2>${isIOS ? 'iPhone：' : ''}Xアプリから1タップで送る（ショートカット）</h2>
      <ol>
        <li>「ショートカット」アプリで新規作成 → 下の ⓘ で<b>「共有シートに表示」</b>をオン。</li>
        <li>アクション「<b>URLエンコード</b>」を追加（入力：ショートカットの入力）。</li>
        <li>アクション「<b>テキスト</b>」を追加し、次の文字列の後ろに「URLエンコードされたテキスト」をつなげる：
          <div class="copy-row"><code id="sc-url">${esc(shortcutUrl)}</code><button class="ghost" data-copy="sc-url">コピー</button></div></li>
        <li>アクション「<b>URLを開く</b>」を追加。名前は「よみあげ文庫へ」など。</li>
      </ol>
      <p class="hint">以後、Xアプリの共有 →「よみあげ文庫へ」で取り込まれます。</p>
    </section>

    <section class="card">
      <h2>Android：共有メニューから送る</h2>
      ${isAndroid ? `<p><b>いまの状態：</b>${isInstalled() ? '✅ アプリとして開いています（インストール済み）' : '⚠️ ブラウザで開いています'}</p>` : ''}
      <ol>
        <li>Chromeでこのページを開き、右上「︙」→「ホーム画面に追加」→「<b>インストール</b>」を選ぶ（本棚画面の「インストールする」ボタンでもOK）。<br>
          <small>「ショートカットを作成」だと共有メニューには出ません。すでにショートカットを作った場合は、ホーム画面のアイコンを削除してから入れ直してください。</small></li>
        <li>インストール後、<b>ホーム画面のアイコンから一度起動</b>する。</li>
        <li>Xアプリで共有 → 一覧に無ければ一番右の「<b>その他</b>」や「編集」から「よみあげ文庫」を探す（よく使うと上に出てきます）。</li>
      </ol>
      <p class="hint">共有メニューを使わない方法：Xで「リンクをコピー」→ よみあげ文庫を開いて「クリップボードから」。</p>
      ${isAndroid ? '' : '<p class="hint">（Androidのみ。iPhoneは上のショートカットを使います）</p>'}
    </section>

    <section class="card">
      <h2>ブラウザで見ているページを送る（ブックマークレット）</h2>
      <p>パソコン：下のボタンをブックマークバーへドラッグ。<br>
         スマホ：何かのページをブックマークし、そのURLを下のコードに書き換え。</p>
      <p><a class="primary btn" href="${esc(bm)}" onclick="return false">📖 よみあげ文庫へ</a></p>
      <div class="copy-row"><code id="bm-code" class="clip">${esc(bm)}</code><button class="ghost" data-copy="bm-code">コピー</button></div>
      <p class="hint">ページを選択してから押すと、選択した部分だけを取り込みます。</p>
    </section>

    <section class="card">
      <h2>パソコン：Xに ▶ ボタンを付ける</h2>
      <p>ブラウザ拡張「Tampermonkey」を入れてから、<a href="${esc(userscriptUrl)}">ユーザースクリプト</a>を開いてインストール。
         Xのポストや記事を開くと右下に ▶ が出て、本文だけをその場で読み上げます（速度変更・文庫への保存つき）。</p>
    </section>

    <section class="card">
      <h2>クラウド音声の準備（画面オフでも読む・声が自然）</h2>
      <ol>
        <li><a href="https://console.cloud.google.com/" target="_blank" rel="noopener">Google Cloud</a> でプロジェクトを作り、<b>請求先アカウント</b>を設定（無料枠内なら0円。カード登録は必要）。</li>
        <li>「Cloud Text-to-Speech API」を<b>有効化</b>。</li>
        <li>「認証情報」→「APIキーを作成」。<b>キーを制限</b>：ウェブサイト＝<code>${esc(new URL(APP_URL).origin)}/*</code>、API＝Cloud Text-to-Speech API のみ。</li>
        <li>「予算とアラート」で<b>月100円などの予算アラート</b>を設定しておくと安心。</li>
        <li>このアプリの設定にAPIキーを貼り、「声の一覧を取得」→ 好きな声を選ぶ。</li>
      </ol>
    </section>

    <section class="card">
      <h2>Drive連携（保存・Driveの文書を読む・Web記事の取得）</h2>
      <ol>
        <li><a href="https://script.google.com/" target="_blank" rel="noopener">Google Apps Script</a> で新しいプロジェクトを作り、リポジトリの <code>gas/Code.gs</code> の中身を貼り付けて保存。</li>
        <li>関数 <code>setup</code> を選んで実行 → 権限を許可 → 実行ログに出る<b>トークン</b>を控える。</li>
        <li>「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」、実行ユーザー「自分」、アクセス「<b>全員</b>」→ URLを控える。</li>
        <li>このアプリの設定に URL とトークンを入力して「接続テスト」。</li>
      </ol>
      <p class="hint">Driveに「よみあげ文庫」フォルダができ、取り込んだ記事がGoogleドキュメントで保存されます。そのフォルダに自分でメモを入れれば「Drive」画面から読み上げられます。</p>
    </section>`;
  view.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => {
      const text = $(`#${b.dataset.copy}`).textContent;
      try {
        await navigator.clipboard.writeText(text);
        toast('コピーしました');
      } catch {
        toast('コピーできませんでした。長押しで選択してください');
      }
    };
  });
}

// ---------------------------------------------------------------- ルーティング

async function route() {
  const hash = location.hash || '#/';
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', hash === a.getAttribute('href') || (a.getAttribute('href') === '#/' && hash.startsWith('#/doc/'))));
  const m = hash.match(/^#\/doc\/(.+)$/);
  window.scrollTo(0, 0);
  if (m) await renderReader(decodeURIComponent(m[1]));
  else if (hash === '#/settings') await renderSettings();
  else if (hash === '#/drive') await renderDrive();
  else if (hash === '#/help') renderHelp();
  else await renderLibrary();
  view.insertAdjacentHTML('beforeend', `<p class="version">よみあげ文庫 v${APP_VERSION}</p>`);
}

async function init() {
  applyFontSize();
  setupPlayerBar();
  window.addEventListener('hashchange', route);
  await route();
  await handleIncoming();
  // 前回聞いていた文書を再生バーに出しておく
  if (!player.doc) {
    const recent = (await docs.all()).filter((d) => d.readAt).sort((a, b) => b.readAt - a.readAt)[0];
    if (recent) player.load(recent);
  }
  updatePlayerBar();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
