/* =====================================================================
 * 日学 · 核心逻辑
 * 打卡 / 每日计划 / 闪卡 / 语法 / 对话 / 阅读 / 语音合成 / 本地持久化
 * ===================================================================== */

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function pad(n) { return String(n).padStart(2, "0"); }
function fmtDate(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function todayStr() { return fmtDate(new Date()); }
function yesterdayStr() {
  const d = new Date(); d.setDate(d.getDate() - 1); return fmtDate(d);
}

// 字符串 hash 种子 → 可复现的随机数生成器（保证同一天抽到的内容一致）
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const rnd = mulberry32(seed);
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// 从一个池子里抽 count 个（池不够时用不同种子补一轮，避免重复单调）
function pickDaily(pool, count, salt) {
  const dateKey = todayStr() + salt;
  const first = seededShuffle(pool, hashSeed(dateKey + ":1"));
  let deck = first;
  let round = 2;
  while (deck.length < count) {
    deck = deck.concat(seededShuffle(pool, hashSeed(dateKey + ":" + round)));
    round++;
  }
  return deck.slice(0, count);
}

/* ---------- 状态 ---------- */
const STORE_KEY = "nichigaku-state-v1";
const DEFAULTS = {
  streak: 0,
  last: "",
  checkIns: [],
  cum: { words: 0, grammar: 0, dialogue: 0 },
  days: {},
  settings: { words: 50, grammar: 10, dialogues: 10, rate: 1, autoSpeak: false, voice: "", furigana: true },
};

let state = loadState();
function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULTS));
    const saved = JSON.parse(raw);
    return {
      ...JSON.parse(JSON.stringify(DEFAULTS)),
      ...saved,
      cum: { ...DEFAULTS.cum, ...(saved.cum || {}) },
      settings: { ...DEFAULTS.settings, ...(saved.settings || {}) },
      days: saved.days || {},
    };
  } catch (e) {
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
  catch (e) { /* 存储满或隐私模式 */ }
}
function dayState() {
  const t = todayStr();
  if (!state.days[t]) state.days[t] = { words: { idx: 0, done: 0 }, grammar: { done: [] }, dialogue: { done: [] } };
  return state.days[t];
}

/* ---------- 语音合成 ---------- */
let voices = [];
let jaVoices = [];
let jaWarned = false;
function loadVoices() {
  voices = window.speechSynthesis ? speechSynthesis.getVoices() : [];
  jaVoices = voices.filter((v) => v.lang && v.lang.toLowerCase().startsWith("ja"));
  populateVoiceSelect();
  refreshTtsNotice();
}
if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}
// 在"发音人"下拉里列出所有日语语音（选过则保留选中）
function populateVoiceSelect() {
  const sel = document.getElementById("setVoice");
  if (!sel) return;
  const current = state.settings.voice || "";
  let html = `<option value="">（自动选择日语语音）</option>`;
  jaVoices.forEach((v) => {
    const label = v.name + (v.localService ? " ·本地" : " ·在线");
    html += `<option value="${esc(v.voiceURI || v.name)}">${esc(label)}</option>`;
  });
  if (!jaVoices.length) html += `<option value="">⚠ 未检测到日语语音</option>`;
  sel.innerHTML = html;
  sel.value = current && jaVoices.some((v) => (v.voiceURI || v.name) === current) ? current : "";
}
// 尽量挑到真正的日语音色（在线日语 > 本地日语常用名）
function jaVoice() {
  const prefer = state.settings.voice;
  if (prefer) {
    const v = voices.find((x) => (x.voiceURI || x.name) === prefer);
    if (v) return v;
  }
  const prefs = ["日本語", "Japan", "Sayaka", "Haruka", "Ichiro", "Nanami", "Keita", "Aoi", "Nuance"];
  for (const key of prefs) {
    const v = jaVoices.find((x) => (x.name || "").indexOf(key) !== -1);
    if (v) return v;
  }
  return jaVoices[0] || null;
}
function canLocalTTS() { return "speechSynthesis" in window; }
let ttsAudio = null, onlineFailed = false, noLocal = false, pendingUrl = "";
function setSpeakStatus(msg) {
  const el = document.getElementById("speakStatus");
  if (el) { el.textContent = msg; }
}
// 网络日语朗读：优先走本机 /tts 代理（手机只需连电脑即可），再兜底直连百度/有道
function ttsUrls(text) {
  const spd = Math.round((Number(state.settings.rate) || 1) * 5);
  const q = encodeURIComponent(text);
  return [
    "/tts?text=" + q + "&spd=" + spd,
    "https://fanyi.baidu.com/getTTS?lan=jp&text=" + q + "&spd=" + spd + "&source=web",
    "https://dict.youdao.com/dictvoice?audio=" + q + "&type=2"
  ];
}
function getAudioEl() {
  if (ttsAudio) return ttsAudio;
  const a = document.createElement("audio");
  a.playsInline = true;
  a.setAttribute("playsinline", "true");
  a.setAttribute("webkit-playsinline", "true");
  a.preload = "auto";
  a.volume = 1;
  a.style.cssText = "position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;";
  document.body.appendChild(a);
  ttsAudio = a;
  return a;
}
function playOnline(text, onEnd) {
  const urls = ttsUrls(text);
  const el = getAudioEl();
  const maBtn = document.getElementById("manualAudio");
  let step = 0, played = false;
  const finish = () => { if (onEnd) onEnd(); };
  const hideManual = () => { if (maBtn) maBtn.classList.add("hidden"); };
  const showManual = () => {
    pendingUrl = urls[0];
    setSpeakStatus("⚠️ 自动播放被拦，请点下方「▶️ 点这里播放语音」");
    if (maBtn) maBtn.classList.remove("hidden");
  };
  // 尝试播放：成功→隐藏按钮；被拦→浮出按钮（点它=用户手势，肯定能放）
  const attempt = () => {
    let p;
    try { p = el.play(); } catch (e) { showManual(); return; }
    if (p && p.then) {
      p.then(() => { played = true; clearTimeout(wd); hideManual(); setSpeakStatus("🔊 播放中"); })
       .catch(() => { if (!played) showManual(); });
    }
  };
  const wd = setTimeout(() => { if (!played) showManual(); }, 3000);
  const tryNext = () => {
    step++;
    if (step >= urls.length) {
      if (!onlineFailed) { onlineFailed = true; setSpeakStatus("⚠️ 在线朗读失败，请在联网状态重试"); }
      showManual(); finish(); return;
    }
    el.src = urls[step]; attempt();
  };
  el.onended = () => { played = true; clearTimeout(wd); finish(); };
  el.onerror = () => { clearTimeout(wd); tryNext(); };
  el.oncanplay = () => { clearTimeout(wd); attempt(); };
  el.src = urls[0]; attempt();
}
function speak(text) {
  // 仅当「支持内置语音」且「确实有日语发音人」才用内置，否则用网络日语朗读，避免念成中文
  if (canLocalTTS() && jaVoices.length) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ja-JP";
    const v = jaVoice(); if (v) u.voice = v;
    u.rate = Number(state.settings.rate) || 1;
    speechSynthesis.speak(u);
    return;
  }
  if (!noLocal) { noLocal = true; toast("本机没有日语语音，已改用网络日语朗读（需联网）"); }
  playOnline(text, null);
}
function speakSequence(texts) {
  const useLocal = canLocalTTS() && jaVoices.length;
  if (useLocal) speechSynthesis.cancel();
  if (!useLocal && !noLocal) { noLocal = true; toast("本机没有日语语音，已改用网络日语朗读（需联网）"); }
  let i = 0;
  const next = () => {
    if (i >= texts.length) return;
    const text = texts[i++];
    if (useLocal) {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP"; const v = jaVoice(); if (v) u.voice = v;
      u.rate = Number(state.settings.rate) || 1;
      u.onend = next; u.onerror = next;
      speechSynthesis.speak(u);
    } else {
      playOnline(text, next);
    }
  };
  next();
}
// 语音环境检测（设置页展示）
function refreshTtsNotice() {
  const el = document.getElementById("ttsNotice");
  if (!el) return;
  const can = canLocalTTS();
  const hasJa = jaVoices.length > 0;
  let msg, cls;
  if (!can) {
    cls = "tts-notice warn";
    msg = "⚠ 本浏览器<b>没有内置语音接口</b>（微信/QQ 内置浏览器、部分 PWA 常见）。<br>已自动改用<b>网络日语朗读</b>（需联网）。<br>建议用<b>手机自带浏览器</b>（Edge/Chrome/Safari）打开，效果最好。";
  } else if (!hasJa) {
    cls = "tts-notice ok";
    msg = "✅ 本机有内置语音，但<b>没有日语发音人</b>，已自动改用<b>网络日语朗读</b>（需联网）。<br>注：网络为<b>真实日语发音</b>，多音源保证尽量出声。";
  } else {
    cls = "tts-notice ok";
    msg = "✅ 本机内置语音可用，检测到 <b>" + jaVoices.length + "</b> 个日语发音人，当前用<b>内置语音</b>。";
  }
  msg += "<br><span style='opacity:.85'>本机语音：" + (can ? "支持" : "不支持") + " · 日语发音人：" + jaVoices.length + " 个</span>";
  el.className = cls;
  el.innerHTML = msg;
}

/* ---------- 注音（ふりがな）---------- */
const FU_CACHE_KEY = "nichigaku-furigana-cache";
const FU_DICT = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict";
let furiganaCache = loadFuriganaCache();
let fsEngine = null, fsReady = false, fsInitPromise = null;
function loadFuriganaCache() { try { return JSON.parse(localStorage.getItem(FU_CACHE_KEY)) || {}; } catch (e) { return {}; } }
function saveFuriganaCache() { try { localStorage.setItem(FU_CACHE_KEY, JSON.stringify(furiganaCache)); } catch (e) {} }
// 把一段日文包进注音容器（尚未转好时先显示原文）
function fur(t) { const e = esc(t); return `<span class="furigana" data-ftext="${e}">${e}</span>`; }
function initFurigana() {
  if (fsInitPromise) return fsInitPromise;
  fsInitPromise = (async () => {
    try {
      if (!window.Kuroshiro || !window.KuromojiAnalyzer) throw new Error("no engine");
      const k = new Kuroshiro();
      await k.init(new KuromojiAnalyzer({ dictPath: FU_DICT }));
      fsEngine = k; fsReady = true;
    } catch (e) { fsReady = false; }
    applyFurigana();
  })();
  return fsInitPromise;
}
async function convertFurigana(text) {
  if (furiganaCache[text]) return furiganaCache[text];
  const out = await fsEngine.convert(text, { to: "hiragana", mode: "furigana" });
  furiganaCache[text] = out; saveFuriganaCache();
  return out;
}
// 给所有 .furigana 容器注音；开关关闭或引擎未就绪时保持原文
function applyFurigana() {
  const on = !!state.settings.furigana;
  document.querySelectorAll(".furigana").forEach((el) => {
    const t = el.dataset.ftext || "";
    if (!on) {
      const plain = esc(t);
      if (el.innerHTML !== plain) el.innerHTML = plain;
      delete el.dataset.done; return;
    }
    if (!fsReady || el.dataset.done) return;
    el.dataset.done = "1";
    convertFurigana(t).then((html) => {
      if (state.settings.furigana && document.contains(el)) el.innerHTML = html;
    }).catch(() => { delete el.dataset.done; });
  });
}

/* ---------- 每日计划生成 ---------- */
let fcQueue = [];      // 当天单词学习队列（内存态）
let fcFlipped = false;
let dailyCache = { words: [], grammar: [], dialogues: [] };   // 当前日期的学习计划
function buildDaily() {
  const s = state.settings;
  return {
    words: pickDaily(VOCAB, Number(s.words) || 50, ":words"),
    grammar: pickDaily(GRAMMAR, Number(s.grammar) || 10, ":grammar"),
    dialogues: pickDaily(DIALOGUES, Number(s.dialogues) || 10, ":dialogues"),
  };
}

/* ---------- Toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 1800);
}

/* ---------- 顶部 / 通用渲染 ---------- */
function renderTopbar() {
  $("#streakNum").textContent = state.streak;
  const t = todayStr();
  const isChecked = state.checkIns.indexOf(t) !== -1;
  $("#todayCheckinBtn").textContent = isChecked ? "✅ 今日已打卡" : "✅ 今日打卡";
  $("#todayCheckinBtn").disabled = isChecked;
  const d = new Date();
  const week = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
  $("#todayDate").textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${week}`;
}

/* ---------- 今日页 ---------- */
function renderToday() {
  renderTopbar();
  const day = dayState();
  const daily = buildDaily();
  dailyCache = daily;

  // 单词闪卡
  $("#wordsProgress").textContent = `${day.words.done}/${daily.words.length}`;
  $("#wordsBar").style.width = (daily.words.length ? (day.words.done / daily.words.length) * 100 : 0) + "%";
  if (!fcQueue.length) {
    fcQueue = daily.words.slice(day.words.idx);
    fcFlipped = false;
  }
  renderCard();

  // 语法
  $("#grammarProgress").textContent = `${day.grammar.done.length}/${daily.grammar.length}`;
  $("#grammarBar").style.width = (daily.grammar.length ? (day.grammar.done.length / daily.grammar.length) * 100 : 0) + "%";
  $("#grammarList").innerHTML = daily.grammar.map((g, i) => {
    const learned = day.grammar.done.indexOf(i) !== -1;
    const exs = g.examples.map((e) =>
      `<div class="g-ex"><div class="jp"><button class="spk" data-speak="${esc(e.jp)}">🔊</button><span>${fur(e.jp)}</span></div><div class="zh">${esc(e.zh)}</div></div>`
    ).join("");
    return `<div class="g-item ${learned ? "open" : ""}" data-gidx="${i}">
      <div class="g-head">
        <div class="g-title"><span class="pattern">${esc(g.pattern)}</span> <span class="zh">${esc(g.title)} · ${esc(g.zh)}</span></div>
        <span class="g-arrow">▾</span>
      </div>
      <div class="g-body">
        <div class="g-explain">${esc(g.explain)}</div>
        ${exs}
        <button class="btn btn-ghost g-learned ${learned ? "" : ""}" data-glearn="${i}">${learned ? "✓ 已学会" : "✓ 标记已学"}</button>
      </div>
    </div>`;
  }).join("");

  // 对话
  $("#dialogueProgress").textContent = `${day.dialogue.done.length}/${daily.dialogues.length}`;
  $("#dialogueBar").style.width = (daily.dialogues.length ? (day.dialogue.done.length / daily.dialogues.length) * 100 : 0) + "%";
  $("#dialogueList").innerHTML = daily.dialogues.map((d, i) => {
    const learned = day.dialogue.done.indexOf(i) !== -1;
    const lines = d.lines.map((l) =>
      `<div class="d-line"><div class="d-bubble">
        <div class="d-speaker">${esc(l.s)}</div>
        <div class="d-jp" data-dspeak="${esc(l.jp)}">${fur(l.jp)}</div>
        <div class="d-zh">${esc(l.zh)}</div>
      </div></div>`
    ).join("");
    return `<div class="d-item" data-didx="${i}">
      <div class="d-head">
        <div class="d-title">💬 ${esc(d.title)} <span class="zh">${esc(d.zh)}</span></div>
        <span class="d-arrow">▾</span>
      </div>
      <div class="d-body">
        ${lines}
        <div class="d-playall">
          <button class="btn btn-ghost" data-dplay="${i}">🔊 整段朗读</button>
          <button class="btn btn-ghost" data-dlearn="${i}">${learned ? "✓ 已学" : "✓ 标记已学"}</button>
        </div>
      </div>
    </div>`;
  }).join("");
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderCard() {
  const day = dayState();
  const box = $("#flashcard");
  const actions = $(".fc-actions");
  const doneBtn = $("#wordsDoneBtn");
  if (!fcQueue.length) {
    box.innerHTML = `<div class="fc-jp">🎉</div><div class="fc-zh">单词已全部学完</div><div class="fc-ex">休息一下，或去学语法、对话吧！</div>`;
    actions.classList.add("hidden");
    doneBtn.classList.remove("hidden");
    return;
  }
  actions.classList.remove("hidden");
  doneBtn.classList.add("hidden");
  const w = fcQueue[0];
  const front = `<span class="fc-hint">轻点卡片 ⇄</span>
    <div class="fc-pos">${esc(w.pos)}</div>
    <div class="fc-jp">${fur(w.jp)}</div>
    <div class="fc-kana">${esc(w.reading)}</div>
    <button class="spk" data-speak="${esc(w.jp)}">🔊</button>`;
  const back = `<span class="fc-hint">轻点卡片 ⇄</span>
    <div class="fc-zh">${esc(w.zh)}</div>
    <div class="fc-ex"><span class="jp">${fur(w.ex)}</span><span class="zh">${esc(w.exZh)}</span></div>
    <button class="spk" data-speak="${esc(w.ex)}">🔊</button>`;
  box.innerHTML = fcFlipped ? back : front;
  if (!fcFlipped && state.settings.autoSpeak) speak(w.jp);
}

function cardNext(known) {
  if (!fcQueue.length) return;
  const w = fcQueue.shift();
  const day = dayState();
  day.words.idx += 1;
  if (known) {
    day.words.done += 1;
    state.cum.words += 1;
  } else {
    // 还不熟 → 放回队列尾部，稍后再复习
    fcQueue.push(w);
  }
  fcFlipped = false;
  saveState();
  renderToday();
}

/* ---------- 打卡页 ---------- */
function checkIn() {
  const t = todayStr();
  if (state.checkIns.indexOf(t) !== -1) {
    toast("今天已经打过卡啦 🌟");
    return;
  }
  state.checkIns.push(t);
  if (state.last === yesterdayStr()) state.streak += 1;
  else state.streak = 1;
  state.last = t;
  saveState();
  renderCheckin();
  renderTopbar();
  renderProfile();
  toast("打卡成功！已连续 " + state.streak + " 天 🔥");
}

let calYear = new Date().getFullYear();
let calMonth = new Date().getMonth();
function renderCheckin() {
  renderTopbar();
  $("#bigFlame").textContent = state.streak > 0 ? "🔥" : "⭕";
  $("#streakBig").textContent = state.streak;
  $("#totalCheckins").textContent = state.checkIns.length;
  $("#mainCheckinBtn").disabled = state.checkIns.indexOf(todayStr()) !== -1;
  renderCalendar();
  renderBadges();
}
function renderCalendar() {
  $("#calTitle").textContent = `${calYear}年${calMonth + 1}月`;
  const first = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const t = todayStr();
  let html = "";
  for (let i = 0; i < first; i++) html += `<div class="cal-cell empty"></div>`;
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${calYear}-${pad(calMonth + 1)}-${pad(d)}`;
    const done = state.checkIns.indexOf(ds) !== -1;
    const isToday = ds === t;
    html += `<div class="cal-cell ${done ? "done" : ""} ${isToday ? "today" : ""}">${done ? "✓" : d}</div>`;
  }
  $("#calGrid").innerHTML = html;
}
function renderBadges() {
  const s = state.streak;
  const list = [
    { ico: "🌱", t: "初次打卡", s: "s ≥ 0", earned: s >= 1 },
    { ico: "🔥", t: "连续 3 天", s: "s ≥ 3", earned: s >= 3 },
    { ico: "📅", t: "连续 7 天", s: "s ≥ 7", earned: s >= 7 },
    { ico: "🏅", t: "连续 30 天", s: "s ≥ 30", earned: s >= 30 },
    { ico: "💎", t: "满月达人", s: "s ≥ 60", earned: s >= 60 },
  ];
  $("#badges").innerHTML = list.map((b) =>
    `<div class="badge ${b.earned ? "earned" : ""}"><div class="ico">${b.ico}</div><div class="t">${b.t}</div><div class="s">${b.s}</div></div>`
  ).join("");
}

/* ---------- 阅读页 ---------- */
let readingIndex = null;
function renderReading() {
  $("#readingList").innerHTML = READINGS.map((r, i) =>
    `<div class="reading-item" data-ridx="${i}">
      <div class="ri-ch"><div class="ri-title">${esc(r.title)} <span class="ri-badge">${esc(r.level)}</span></div>
      <div class="ri-meta">${esc(r.zh)} · ${r.paragraphs.length} 段 · 朗读可点击播放</div></div>
      <span class="ri-arrow">›</span>
    </div>`
  ).join("");
  if (readingIndex !== null) openReader(readingIndex);
}
function openReader(i) {
  readingIndex = i;
  const r = READINGS[i];
  if (!r) return;
  $("#readingList").classList.add("hidden");
  $("#reader").classList.remove("hidden");
  const paras = r.paragraphs.map((p) =>
    `<div class="r-para"><div class="r-jp" data-speak="${esc(p.jp)}">${fur(p.jp)}</div><div class="r-zh hidden">${esc(p.zh)}</div></div>`
  ).join("");
  const quiz = r.questions.map((q, qi) =>
    `<div class="r-q" data-qidx="${qi}">
      <div class="q-text">${qi + 1}. ${esc(q.q)}</div>
      ${q.options.map((o, oi) => `<button class="opt" data-opt="${oi}">${esc(o)}</button>`).join("")}
      <div class="exp">${esc(q.exp)}</div>
    </div>`
  ).join("");
  $("#readerContent").innerHTML = `
    <h2>${esc(r.title)} <span class="ri-badge">${esc(r.level)}</span></h2>
    <div class="r-meta">${esc(r.zh)}</div>
    <div class="r-controls">
      <button class="btn btn-ghost" id="readerToggle">👁 显示/隐藏译文</button>
      <button class="btn btn-ghost" data-playall="${esc(r.paragraphs.map(p => p.jp).join("|||"))}">🔊 朗读全文</button>
    </div>
    ${paras}
    <div class="r-quiz">${quiz}</div>`;
}
function closeReader() {
  readingIndex = null;
  $("#readingList").classList.remove("hidden");
  $("#reader").classList.add("hidden");
}

/* ---------- 我的页 ---------- */
function renderProfile() {
  renderTopbar();
  loadVoices();
  $("#statStreak").textContent = state.streak;
  $("#statWords").textContent = state.cum.words;
  $("#statGrammar").textContent = state.cum.grammar;
  $("#statDialogue").textContent = state.cum.dialogue;
  $("#setWords").value = String(state.settings.words);
  $("#setGrammar").value = String(state.settings.grammar);
  $("#setDialogues").value = String(state.settings.dialogues);
  $("#setRate").value = String(state.settings.rate);
  $("#setAutoSpeak").checked = !!state.settings.autoSpeak;
  $("#setFurigana").checked = !!state.settings.furigana;
  refreshTtsNotice();
}

/* ---------- Tab 切换 ---------- */
function switchTab(name) {
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + name));
  if (name === "today") renderToday();
  else if (name === "checkin") renderCheckin();
  else if (name === "reading") renderReading();
  else if (name === "profile") renderProfile();
  window.scrollTo(0, 0);
}

/* ---------- 全局事件委托 ---------- */
document.addEventListener("click", function (e) {
  const spk = e.target.closest("[data-speak]");
  if (spk) {
    e.stopPropagation();
    speak(spk.dataset.speak);
    return;
  }

  const playAll = e.target.closest("[data-playall]");
  if (playAll) {
    e.stopPropagation();
    const texts = playAll.dataset.playall.split("|||").filter(Boolean);
    speakSequence(texts);
    return;
  }

  // 对话单句朗读
  const dSpeak = e.target.closest("[data-dspeak]");
  if (dSpeak) {
    e.stopPropagation();
    speak(dSpeak.dataset.dspeak);
    return;
  }

  // 对话整段朗读
  const dPlay = e.target.closest("[data-dplay]");
  if (dPlay) {
    e.stopPropagation();
    const dl = dailyCache.dialogues[Number(dPlay.dataset.dplay)];
    if (dl) speakSequence(dl.lines.map((l) => l.jp));
    return;
  }

  // 单词卡片翻面
  if (e.target.closest("#flashcard")) {
    fcFlipped = !fcFlipped;
    renderCard();
    return;
  }

  // 闪卡按钮
  if (e.target.closest("#fcYes")) { cardNext(true); return; }
  if (e.target.closest("#fcNo")) { cardNext(false); return; }

  // 语法折叠
  const gLearn = e.target.closest("[data-glearn]");
  if (gLearn) {
    const i = Number(gLearn.dataset.glearn);
    const day = dayState();
    if (day.grammar.done.indexOf(i) === -1) {
      day.grammar.done.push(i);
      state.cum.grammar += 1;
      saveState();
      renderToday();
    }
    return;
  }
  const gHead = e.target.closest(".g-head");
  if (gHead) {
    gHead.closest(".g-item").classList.toggle("open");
    return;
  }

  // 对话折叠 / 标记已学
  const dLearn = e.target.closest("[data-dlearn]");
  if (dLearn) {
    const i = Number(dLearn.dataset.dlearn);
    const day = dayState();
    if (day.dialogue.done.indexOf(i) === -1) {
      day.dialogue.done.push(i);
      state.cum.dialogue += 1;
      saveState();
      renderToday();
    }
    return;
  }
  const dHead = e.target.closest(".d-head");
  if (dHead) {
    dHead.closest(".d-item").classList.toggle("open");
    return;
  }

  // 阅读文章打开
  const rItem = e.target.closest("[data-ridx]");
  if (rItem) { openReader(Number(rItem.dataset.ridx)); return; }

  // 阅读答题
  const opt = e.target.closest("[data-opt]");
  if (opt) {
    const qBox = opt.closest(".r-q");
    const q = READINGS[readingIndex].questions[Number(qBox.dataset.qidx)];
    $$(".opt", qBox).forEach((o, oi) => {
      o.classList.remove("ok", "bad");
      if (oi === q.a) o.classList.add("ok");
    });
    if (Number(opt.dataset.opt) !== q.a) opt.classList.add("bad");
    else qBox.querySelector(".exp").style.display = "block";
    return;
  }

  if (e.target.closest("#readerToggle")) {
    $$(".reader .r-zh").forEach((z) => z.classList.toggle("hidden"));
    return;
  }
});

document.addEventListener("change", function (e) {
  if (e.target.id === "setWords") {
    state.settings.words = Number(e.target.value); saveState(); toast("已更新每日单词量，明天生效");
  } else if (e.target.id === "setGrammar") {
    state.settings.grammar = Number(e.target.value); saveState(); toast("已更新每日语法量");
  } else if (e.target.id === "setDialogues") {
    state.settings.dialogues = Number(e.target.value); saveState(); toast("已更新每日对话量");
  } else if (e.target.id === "setRate") {
    state.settings.rate = Number(e.target.value); saveState(); toast("语速已更新");
  } else if (e.target.id === "setAutoSpeak") {
    state.settings.autoSpeak = e.target.checked; saveState();
  } else if (e.target.id === "setVoice") {
    state.settings.voice = e.target.value; saveState();
    const v = jaVoices.find((x) => (x.voiceURI || x.name) === e.target.value);
    toast(v ? "已选择：" + v.name : "自动选择日语语音");
    if (v) speak("こんにちは、日本語を勉強しましょう。");
  } else if (e.target.id === "setFurigana") {
    state.settings.furigana = e.target.checked; saveState(); applyFurigana();
    toast(e.target.checked ? "已开启注音（在线加载词典后显示）" : "已关闭注音");
  }
});

/* ---------- 按钮绑定 ---------- */
$("#todayCheckinBtn").addEventListener("click", checkIn);
$("#mainCheckinBtn").addEventListener("click", checkIn);
$("#settingsBtn").addEventListener("click", () => switchTab("profile"));
$$(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));
$("#readerBack").addEventListener("click", closeReader);
$("#calPrev").addEventListener("click", () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); });
$("#calNext").addEventListener("click", () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); });
$("#testSpeak").addEventListener("click", () => {
  speak("こんにちは");
  // 装好原生播放器（自动播放被拦时用它），并把加载状态显示出来
  const mp = document.getElementById("miniPlayer");
  if (mp) {
    mp.volume = 1;
    mp.onloadedmetadata = () => {
      const d = isFinite(mp.duration) ? (mp.duration.toFixed(1) + " 秒") : "未知";
      setSpeakStatus("✅ 音频已加载（" + d + "），点上面播放条的 ► 即可出声");
    };
    mp.onplaying = () => setSpeakStatus("🔊 正在播放…");
    mp.onerror = () => {
      const code = mp.error ? mp.error.code : "?";
      mp.onerror = () => { mp.src = ttsUrls("こんにちは")[1]; mp.load(); };
      setSpeakStatus("❌ 音频加载失败（错误码 " + code + "）——手机取不到 fanyi.baidu.com 的音频");
      mp.src = ttsUrls("こんにちは")[1]; mp.load();
    };
    mp.src = ttsUrls("こんにちは")[0];
    mp.load();
  }
});
$("#netCheck").addEventListener("click", async () => {
  setSpeakStatus("⏳ 正在检测手机能否连外网…");
  try {
    await fetch("https://www.baidu.com", { mode: "no-cors", cache: "no-store" });
    setSpeakStatus("✅ 手机能连外网，可正常使用网络日语朗读");
    onlineFailed = false;
  } catch (e) {
    setSpeakStatus("❌ 连不上外网：请让手机连上有互联网的 Wi-Fi（或打开流量）。注：手机需与电脑连同一个 Wi-Fi 才能打开本页面，但播声音还要求该网络能上外网。");
  }
});
$("#manualAudio").addEventListener("click", () => {
  const el = getAudioEl();
  if (pendingUrl) {
    setSpeakStatus("🔊 正在播放…");
    el.src = pendingUrl;
    try { el.play().catch(() => {}); } catch (e) {}
  } else {
    speak("こんにちは");
  }
});
$("#resetBtn").addEventListener("click", () => {
  if (confirm("确定清除全部学习数据吗？此操作无法恢复。")) {
    localStorage.removeItem(STORE_KEY);
    state = JSON.parse(JSON.stringify(DEFAULTS));
    fcQueue = []; fcFlipped = false; readingIndex = null;
    renderToday(); renderProfile();
    toast("数据已清除");
  }
});

/* ---------- 手机安装（PWA 一键安装）---------- */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  const b = $("#installBtn");
  if (b) b.textContent = "📲 一键安装到手机";
});
if ($("#installBtn")) {
  $("#installBtn").addEventListener("click", async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
      toast("安装完成，去主屏幕/桌面看看 🎉");
    } else {
      toast("请用浏览器菜单「添加到主屏幕」（iPhone 用 Safari：分享→添加到主屏幕）");
    }
  });
}

/* ---------- 启动 ---------- */
// DOM 变化后自动补注音（含初次渲染、切页、翻卡、展开等）
let furiObserverPending = false;
const furiObserver = new MutationObserver(() => {
  if (furiObserverPending) return; furiObserverPending = true;
  setTimeout(() => { furiObserverPending = false; applyFurigana(); }, 120);
});
furiObserver.observe(document.body, { childList: true, subtree: true });

const todayDay = dayState();
fcQueue = buildDaily().words.slice(todayDay.words.idx);
renderToday();
initFurigana();
