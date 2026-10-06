// ==UserScript==
// @name         よみあげ文庫 for X
// @namespace    https://github.com/yayoi333/bookreader
// @version      0.1.0
// @description  Xのポスト・記事に▶ボタンを付けて、本文だけをその場で読み上げます（速度変更・文庫へ送る）
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.fxtwitter.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULT_APP = 'https://yayoi333.github.io/bookreader/';
  const appUrl = () => GM_getValue('appUrl', DEFAULT_APP);
  GM_registerMenuCommand('よみあげ文庫のURLを設定', () => {
    const v = prompt('よみあげ文庫のURL', appUrl());
    if (v) GM_setValue('appUrl', v.endsWith('/') ? v : v + '/');
  });

  const synth = window.speechSynthesis;
  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

  // ---- 本文の取得（FxTwitter API・非公式/無料） ----
  function statusId(path) {
    const m = path.match(/\/(?:status|statuses|article)\/(\d+)/);
    return m ? m[1] : null;
  }

  function fetchJson(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        responseType: 'json',
        onload: (r) => resolve(r.response || JSON.parse(r.responseText)),
        onerror: () => reject(new Error('通信エラー')),
      });
    });
  }

  async function loadText(id) {
    const json = await fetchJson(`https://api.fxtwitter.com/status/${id}`);
    if (!json || json.code !== 200) throw new Error(json?.message || '取得できませんでした');
    const t = json.tweet;
    const parts = [];
    if (t.article?.content?.blocks?.length) {
      if (t.article.title) parts.push(t.article.title);
      for (const b of t.article.content.blocks) {
        if (b.type !== 'atomic' && b.text?.trim()) parts.push(b.text.trim());
      }
    } else {
      parts.push(t.text || '');
      if (t.quote?.text) parts.push(`引用。${t.quote.text}`);
    }
    return parts.join('\n');
  }

  // ---- 文に分けて読み上げ用に整える（アプリ本体 js/text.js の簡易版） ----
  function clean(s) {
    return s
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\p{Extended_Pictographic}|[‍️]/gu, '')
      .replace(/^\s*(?:[-*+]\s+|[・•●■□◆◇▶★☆※]\s*)/gm, '')
      .replace(/[#＃](?=\S)/g, '')
      .replace(/[@＠](?=\w)/g, '')
      .replace(/[→⇒]/g, '、')
      .replace(/([！!？?])[！!？?]+/g, '$1')
      .trim();
  }

  function sentences(text) {
    const out = [];
    for (const line of text.split('\n')) {
      const parts = line.match(/[^。！？!?]+[。！？!?」』）)]*|[。！？!?]+/g) || [];
      for (let p of parts) {
        p = clean(p);
        while (p.length > 120) {
          let cut = p.lastIndexOf('、', 120);
          if (cut < 40) cut = 120;
          else cut += 1;
          out.push(p.slice(0, cut));
          p = p.slice(cut);
        }
        if (p.trim()) out.push(p);
      }
    }
    return out;
  }

  // ---- 再生 ----
  const state = { id: null, segs: [], i: 0, playing: false, gen: 0, utter: null };

  function pickVoice() {
    const ja = synth.getVoices().filter((v) => /^ja/i.test(v.lang));
    const score = (v) => (/Natural|Online/.test(v.name) ? 50 : 0) + (/Premium|Enhanced|拡張/.test(v.name) ? 40 : 0) + (/Google/.test(v.name) ? 20 : 0);
    return ja.sort((a, b) => score(b) - score(a))[0] || null;
  }

  function speak(i, gen) {
    if (gen !== state.gen) return;
    if (i >= state.segs.length) {
      state.playing = false;
      state.i = 0;
      render('最後まで読みました');
      return;
    }
    state.i = i;
    render();
    const u = new SpeechSynthesisUtterance(state.segs[i]);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang || 'ja-JP';
    u.rate = Number(GM_getValue('rate', 1));
    u.onend = () => speak(i + 1, gen);
    u.onerror = (e) => {
      if (e.error !== 'interrupted' && e.error !== 'canceled') speak(i + 1, gen);
    };
    state.utter = u;
    synth.speak(u);
  }

  function start(i) {
    const gen = ++state.gen;
    state.playing = true;
    const busy = synth.speaking || synth.pending;
    synth.cancel();
    if (busy) setTimeout(() => speak(i, gen), 80);
    else speak(i, gen);
  }

  function stop() {
    state.gen++;
    state.playing = false;
    synth.cancel();
    render();
  }

  async function onPlay() {
    const id = statusId(location.pathname);
    if (!id) return;
    if (state.playing) return stop();
    if (state.id !== id) {
      render('読み込み中…');
      try {
        state.segs = sentences(await loadText(id));
        state.id = id;
        state.i = 0;
      } catch (e) {
        render(e.message);
        return;
      }
    }
    start(state.i);
  }

  // ---- UI ----
  const box = document.createElement('div');
  box.style.cssText =
    'position:fixed;right:20px;bottom:20px;z-index:99999;display:none;align-items:center;gap:8px;padding:8px 12px;' +
    'background:#b5532f;color:#fff;border-radius:999px;box-shadow:0 4px 16px rgba(0,0,0,.25);font:14px system-ui,sans-serif';
  box.innerHTML =
    '<button data-a="play" style="all:unset;cursor:pointer;font-size:20px;width:28px;text-align:center">▶</button>' +
    '<button data-a="prev" title="前の文" style="all:unset;cursor:pointer">⏮</button>' +
    '<button data-a="next" title="次の文" style="all:unset;cursor:pointer">⏭</button>' +
    '<select data-a="rate" style="background:#fff;color:#2b2620;border:0;border-radius:999px;padding:2px 6px"></select>' +
    '<span data-a="msg" style="max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></span>' +
    '<button data-a="send" title="よみあげ文庫に保存" style="all:unset;cursor:pointer">📚</button>';
  document.body.appendChild(box);
  const q = (a) => box.querySelector(`[data-a="${a}"]`);
  q('rate').innerHTML = RATES.map((r) => `<option value="${r}">${r}x</option>`).join('');
  q('rate').value = String(GM_getValue('rate', 1));
  q('rate').onchange = () => {
    GM_setValue('rate', Number(q('rate').value));
    if (state.playing) start(state.i);
  };
  q('play').onclick = onPlay;
  q('prev').onclick = () => state.segs.length && (state.playing ? start(Math.max(0, state.i - 1)) : ((state.i = Math.max(0, state.i - 1)), render()));
  q('next').onclick = () => state.segs.length && (state.playing ? start(Math.min(state.segs.length - 1, state.i + 1)) : ((state.i = Math.min(state.segs.length - 1, state.i + 1)), render()));
  q('send').onclick = () => window.open(`${appUrl()}?url=${encodeURIComponent(location.href)}&save=1`, '_blank');

  function render(msg) {
    q('play').textContent = state.playing ? '⏸' : '▶';
    q('msg').textContent = msg || (state.segs.length ? `${state.i + 1}/${state.segs.length}` : '本文を読み上げ');
  }

  // X は画面遷移でページを読み直さないので、URLの変化を見張る
  let lastPath = '';
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const id = statusId(lastPath);
    box.style.display = id ? 'flex' : 'none';
    if (id !== state.id) {
      if (state.playing) stop();
      state.segs = [];
      state.i = 0;
      state.id = null;
    }
    render();
  }, 700);
})();
