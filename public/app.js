const $ = (id) => document.getElementById(id);
let CFG = null;
const activeJobs = new Set();   // id задач в работе (параллельно)
let jobTimer = null;            // общий опрос всех активных задач
const MODELS = {};        // id -> модель (публичный вид с сервера)
let ORDER = [];           // порядок вкладок
let active = null;        // id активной модели
const state = {};         // id -> состояние вкладки (настройки, рефы, промпт)
const RES_META = { "360p": { tag: "LQ", scale: .3 }, "480p": { tag: "SD", scale: .45 }, "540p": { tag: "qHD", scale: .52 }, "720p": { tag: "HD", scale: .62 }, "1080p": { tag: "FHD", scale: .82 }, "4k": { tag: "4K", scale: 1 } };

const S = () => state[active];   // состояние активной вкладки
// эффективная модель: для fal подмешиваем выбранную подмодель (её ui/pricing/цену)
function M() {
  const base = MODELS[active];
  if (!base.submodels) return base;
  const sub = base.submodels.find((s) => s.id === S().submodel) || base.submodels[0];
  return { ...base, ui: sub.ui, pricing: sub.pricing, pricingModel: sub.pricingModel || base.pricingModel, fps: sub.fps || base.fps, badge: sub.label, _sub: sub };
}
const baseModel = () => MODELS[active]; // «сырая» модель (с submodels)
const subKey = (m) => (m && m._sub ? m._sub.id : active); // ключ пер-подмодельных настроек (негатив, CFG)

async function init() {
  CFG = await (await fetch("/api/config")).json();
  if ($("appVer")) $("appVer").textContent = "v" + (CFG.version || "?");
  ORDER = CFG.models.map((m) => m.id);
  for (const m of CFG.models) MODELS[m.id] = m;
  active = MODELS[CFG.defaultModel] ? CFG.defaultModel : ORDER[0];

  // начальное состояние каждой вкладки из её defaults
  for (const id of ORDER) {
    const m = MODELS[id], d = m.defaults || {};
    const ui0 = m.ui || (m.submodels ? m.submodels[0].ui : {});
    const sw = {}; for (const s of (ui0.switches || [])) sw[s.id] = !!(s.default ?? d[s.id]);
    state[id] = {
      mode: d.mode || null,
      submodel: d.submodel || (m.submodels ? m.submodels[0].id : null),
      task: d.task || (ui0.tasks ? ui0.tasks[0].id : null),
      resolution: d.resolution, aspectRatio: d.aspectRatio, duration: d.duration,
      seed: d.seed || "", prompt: "", sw, refs: { images: [], videos: [], audios: [] },
    };
  }

  buildTabs();
  renderKeys();
  // слушатели, общие для всех вкладок (DOM переиспользуется)
  $("duration").addEventListener("input", () => { S().duration = Number($("duration").value); $("durVal").textContent = $("duration").value + " c"; updateCost(); });
  $("seed").addEventListener("input", () => { S().seed = $("seed").value; });
  $("cfg").addEventListener("input", () => {
    const v = Number($("cfg").value); $("cfgVal").textContent = v.toFixed(2);
    S().cfgs = S().cfgs || {}; S().cfgs[subKey(M())] = v;
  });
  $("negative").addEventListener("input", () => {
    S().negs = S().negs || {}; S().negs[subKey(M())] = $("negative").value;
  });

  renderModel();
  setupRefs(); bindGen(); setupAppearance(); setupPrompt();
  autoUpdateCheck();
}

// ── вкладки движков ─────────────────────────────────────────
function buildTabs() {
  const el = $("modelTabs"); el.innerHTML = "";
  for (const id of ORDER) {
    const m = MODELS[id];
    const t = document.createElement("button"); t.className = "mtab" + (id === active ? " on" : ""); t.dataset.id = id;
    const ic = m.provider === "google" ? "G" : m.provider === "fal" ? "◆" : "▶";
    t.innerHTML = `<span class="mt-ic">${ic}</span><span class="mt-txt"><span class="mt-tt">${m.label}</span><span class="mt-sub">${m.badge}</span></span>` +
      `<span class="mt-key ${m.keyPresent ? "ok" : "no"}">${m.keyPresent ? "● ключ" : "нет ключа"}</span>`;
    t.onclick = () => { if (active === id) return; captureInputs(); active = id; renderModel(); };
    el.appendChild(t);
  }
}
function captureInputs() { S().prompt = $("prompt").value; S().seed = $("seed").value; S().duration = Number($("duration").value); }

// ── ключи API (по каждой модели) ────────────────────────────
function renderKeys() {
  const box = $("keysList"); box.innerHTML = "";
  for (const id of ORDER) {
    const m = MODELS[id];
    const row = document.createElement("div"); row.className = "keyrow"; row.dataset.id = id;
    row.innerHTML =
      `<div class="kr-head">${m.label} <code style="font-weight:400;color:var(--text3);font-size:11px">${m.apiKeyEnv}</code>` +
      `<span class="kr-status ${m.keyPresent ? "ok" : "no"}">${m.keyPresent ? "● установлен" : "нет ключа"}</span></div>` +
      `<div class="kr-in"><input type="password" class="kr-input" autocomplete="off" spellcheck="false" ` +
      `placeholder="${m.keyPresent ? "введите новый ключ для замены" : "вставьте ключ"}">` +
      `<button class="kr-eye" title="Показать/скрыть">👁</button><button class="kr-save">Сохранить</button></div>` +
      `<div class="kr-msg"></div>` +
      (m.purchaseUrl ? `<div class="kr-link">Где взять: <a href="${m.purchaseUrl}" target="_blank" rel="noopener">${m.purchaseUrl.replace(/^https?:\/\//, "")}</a></div>` : "");
    const input = row.querySelector(".kr-input");
    row.querySelector(".kr-eye").onclick = () => { input.type = input.type === "password" ? "text" : "password"; };
    row.querySelector(".kr-save").onclick = () => saveKey(id, input, row);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveKey(id, input, row); } });
    box.appendChild(row);
  }
}
async function saveKey(id, input, row) {
  const msg = row.querySelector(".kr-msg");
  const key = input.value.trim();
  if (!key && !confirm("Пустой ключ очистит сохранённый и выключит модель. Продолжить?")) return;
  msg.className = "kr-msg"; msg.textContent = "Сохраняю…";
  try {
    const r = await fetch("/api/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id, key }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || "ошибка");
    MODELS[id].keyPresent = d.keyPresent;
    input.value = ""; input.type = "password";
    input.placeholder = d.keyPresent ? "введите новый ключ для замены" : "вставьте ключ";
    const badge = row.querySelector(".kr-status");
    badge.className = "kr-status " + (d.keyPresent ? "ok" : "no");
    badge.textContent = d.keyPresent ? "● установлен" : "нет ключа";
    msg.className = "kr-msg ok"; msg.textContent = d.keyPresent ? "✓ ключ сохранён — модель включена (рестарт не нужен)" : "✓ ключ очищен";
    buildTabs();
    if (id === active) renderModel();
  } catch (e) { msg.className = "kr-msg err"; msg.textContent = "✕ " + e.message; }
}

// ── рендер активной модели ──────────────────────────────────
function renderModel() {
  const m = M();
  document.querySelectorAll("#modelTabs .mtab").forEach((b) => b.classList.toggle("on", b.dataset.id === active));
  $("provBadge").textContent = m.badge;
  $("settingsModel").textContent = m.label;
  $("acctModel").textContent = m.label;
  $("topupBtn").href = m.purchaseUrl; $("topupBtn").textContent = m.buyLabel || "💳 Пополнить кредиты";

  buildSubmodels(); buildModes(); buildTasks(); buildResolutions(); buildAspects(); buildSwitches();

  // длительность (подгоняем под диапазон/шаг активной (под)модели; разрешение может резать максимум — PixVerse 1080p ≤ 5 c)
  const du = $("duration");
  const durCap = m.ui.resolutionMaxDur ? m.ui.resolutionMaxDur[S().resolution] : null;
  du.min = m.ui.durationMin; du.max = durCap ? Math.min(m.ui.durationMax, durCap) : m.ui.durationMax; du.step = m.ui.durationStep || 1;
  const step = Number(du.step) || 1, mn = Number(du.min), mx = Number(du.max);
  let dv = Number(S().duration); if (!isFinite(dv)) dv = mn;
  dv = Math.min(mx, Math.max(mn, Math.round((dv - mn) / step) * step + mn));
  S().duration = dv; du.value = dv; $("durVal").textContent = dv + " c";
  $("durMinLab").textContent = mn + " c"; $("durMaxLab").textContent = mx + " c";

  // seed
  $("fieldSeed").style.display = m.ui.seed ? "" : "none";
  $("seed").value = S().seed || "";

  // негатив-промпт (модели с negative_prompt)
  const negOn = !!m.ui.negative;
  $("fieldNegative").style.display = negOn ? "" : "none";
  if (negOn) {
    const k = subKey(m);
    $("negative").value = (S().negs && S().negs[k] != null) ? S().negs[k] : (m.ui.negativeDefault || "");
  }

  // CFG-слайдер (модели с cfg_scale)
  const cfgOn = !!m.ui.cfg;
  $("fieldCfg").style.display = cfgOn ? "" : "none";
  if (cfgOn) {
    const c = m.ui.cfg, el = $("cfg");
    el.min = c.min; el.max = c.max; el.step = c.step;
    const k = subKey(m);
    const v = (S().cfgs && S().cfgs[k] != null) ? S().cfgs[k] : c.default;
    el.value = v; $("cfgVal").textContent = Number(v).toFixed(2);
    if (c.help) $("cfgHelp").title = c.help;
  }

  // заметка модели
  const note = m.ui.note; $("modelNote").style.display = note ? "" : "none"; if (note) $("modelNote").textContent = note;

  refreshRefsUI();

  // промпт
  const pt = $("prompt");
  pt.value = S().prompt || "";
  pt.placeholder = m.provider === "google"
    ? "Опиши сцену и действие. С картинкой-рефом: «оживи кадр — камера медленно наезжает…». Omni сам добавит звук."
    : "Опиши сцену. Для человека: «персонаж как на @Image1 …» — лицо/внешность зафиксируются по рефу. Камеру копируй с @Video1, музыку — с @Audio1.";
  if (typeof growPrompt === "function") growPrompt();

  // цена / кнопка покупки
  $("buyBtn").href = m.purchaseUrl; $("buyBtn").textContent = m.buyLabel || "💳 Купить";
  renderPriceTable(); updateCost();
  loadGallery();
}

function buildSubmodels() {
  const base = baseModel(), f = $("fieldSubmodel"), box = $("submodelCards");
  if (!base.submodels) { f.style.display = "none"; return; }
  f.style.display = ""; box.innerHTML = "";
  for (const s of base.submodels) {
    const sec = s.pricing?.perSecond?.sec;
    const feats = [];
    const hasSwitchAudio = (s.ui.switches || []).some((x) => x.id === "audio");
    if (s.ui.audioNative) feats.push("🔊 звук");
    else if (hasSwitchAudio) feats.push("🔊 звук (опц.)");
    if (s.input?.imageField) feats.push(s.input.endImageField ? "🖼 старт+финал" : "🖼 кадр→видео");
    feats.push("⏱ " + (s.ui.durationMin === s.ui.durationMax ? s.ui.durationMin : s.ui.durationMin + "–" + s.ui.durationMax) + " c");
    if (s.ui.resolutions) feats.push("📐 до " + s.ui.resolutions[s.ui.resolutions.length - 1]);
    else if (s.ui.resFixed) feats.push("📐 " + s.ui.resFixed);
    const c = document.createElement("div");
    c.className = "sm-card" + (s.id === S().submodel ? " on" : "");
    c.innerHTML = `<div class="sm-top"><span class="sm-name">${escapeHtml(s.label)}</span><span class="sm-price">${sec != null ? "$" + sec.toFixed(2) + "/с" : ""}</span></div>` +
      `<div class="sm-vendor">${escapeHtml(s.vendor || "")}</div>` +
      `<div class="sm-feats">${feats.map((x) => `<span>${x}</span>`).join("")}</div>`;
    c.onclick = () => { if (S().submodel === s.id) return; S().submodel = s.id; renderModel(); };
    box.appendChild(c);
  }
}

function buildModes() {
  const m = M(), f = $("fieldModes"), el = $("mode");
  if (!m.ui.modes) { f.style.display = "none"; return; }
  f.style.display = ""; el.innerHTML = "";
  for (const mo of m.ui.modes) {
    const b = document.createElement("button"); b.textContent = mo.label;
    if (mo.id === S().mode) b.classList.add("on");
    b.onclick = () => { S().mode = mo.id; [...el.children].forEach((c) => c.classList.toggle("on", c === b)); buildResolutions(); renderPriceTable(); updateCost(); };
    el.appendChild(b);
  }
}

function buildTasks() {
  const m = M(), f = $("fieldTasks"), el = $("task");
  if (!m.ui.tasks) { f.style.display = "none"; return; }
  f.style.display = ""; el.innerHTML = "";
  const cur = S().task || m.ui.tasks[0].id;
  const help = m.ui.tasks.find((t) => t.help)?.help; if (help) $("taskHelp").title = help;
  for (const t of m.ui.tasks) {
    const b = document.createElement("button"); b.textContent = t.label;
    if (t.id === cur) b.classList.add("on");
    b.onclick = () => { S().task = t.id; [...el.children].forEach((c) => c.classList.toggle("on", c === b)); };
    el.appendChild(b);
  }
}

function buildResolutions() {
  const m = M(), f = $("fieldResolution");
  const list = m.ui.modes ? (m.ui.resolutionsByMode?.[S().mode] || []) : (m.ui.resolutions || []);
  // нет выбора (Omni, Kling) — просто прячем поле, НЕ стирая выбор вкладки (иначе клик по Kling сбрасывал 1080p)
  if (!list.length) { f.style.display = "none"; return; }
  f.style.display = "";
  if (!list.includes(S().resolution)) {
    const def = (baseModel().defaults || {}).resolution;
    S().resolution = list.includes(def) ? def : list[Math.min(1, list.length - 1)];
  }
  const el = $("resolution"); el.innerHTML = "";
  for (const r of list) {
    const meta = RES_META[r] || { tag: "", scale: .6 };
    const c = document.createElement("div"); c.className = "chip" + (r === S().resolution ? " on" : "");
    c.dataset.res = r;
    const hint = resPriceHint(m, S(), r);
    c.innerHTML = `<span class="res-box"><i style="height:${Math.round(meta.scale * 22)}px"></i></span><b>${r}</b><span class="res-tag">${meta.tag}</span>` +
      (hint ? `<span class="res-price">${hint}</span>` : "");
    // через renderModel: смена разрешения может менять допустимую длительность (напр. PixVerse 1080p ≤ 5 c)
    c.onclick = () => { S().resolution = r; renderModel(); };
    el.appendChild(c);
  }
}

// тариф $/с для perSecond-моделей: может зависеть от разрешения (byRes) и звука ({on,off}/secAudio)
function perSecRate(pc, resolution, audio) {
  let sec = pc.byRes ? pc.byRes[resolution] : undefined;
  if (sec == null) sec = (audio && pc.secAudio != null) ? pc.secAudio : (pc.sec || 0);
  else if (typeof sec === "object") sec = audio ? (sec.on ?? 0) : (sec.off ?? 0);
  return sec;
}
function audioOn(m, s) {
  return !!(m.ui.audioNative || (m.ui.switches || []).some((x) => x.id === "audio" && s.sw[x.id]));
}

// оценка цены конкретного разрешения при текущих длительности/звуке
function resPriceHint(m, s, r) {
  if (m.pricingModel === "perSecond") {
    const pc = m.pricing.perSecond || {};
    if (!pc.byRes || pc.byRes[r] == null) return "";
    return "≈$" + (perSecRate(pc, r, audioOn(m, s)) * Number(s.duration)).toFixed(2);
  }
  if (m.pricingModel !== "tokens" || !m.ui.shortSides) return "";
  const short = m.ui.shortSides[r]; if (!short) return "";
  let factor = 16 / 9;
  if (s.aspectRatio !== "adaptive" && s.aspectRatio && s.aspectRatio.includes(":")) {
    const [a, b] = s.aspectRatio.split(":").map(Number); factor = Math.max(a, b) / Math.min(a, b);
  }
  const u = m.pricing.unitPerK[s.mode] && m.pricing.unitPerK[s.mode][r]; if (!u) return "";
  const perK = s.refs.videos.length ? u.v : u.nv;
  const tokens = short * short * factor * m.fps * Number(s.duration) / 1024;
  return "≈$" + (tokens / 1000 * perK).toFixed(2);
}

function buildAspects() {
  const el = $("aspectRatio"); el.innerHTML = "";
  const list = M().ui.aspectRatios || [];
  // пусто — формат задаёт входная картинка (напр. Kling 4K, только кадр→видео): прячем блок
  if (!list.length) { $("fieldAspect").style.display = "none"; return; }
  $("fieldAspect").style.display = "";
  // выбор из другой подмодели может быть недопустим здесь (21:9 → Kling = 422) — приводим к валидному
  if (!list.includes(S().aspectRatio)) {
    const def = (baseModel().defaults || {}).aspectRatio;
    S().aspectRatio = list.includes(def) ? def : list[0];
  }
  for (const ar of list) {
    const c = document.createElement("div"); c.className = "chip" + (ar === S().aspectRatio ? " on" : "");
    let shape;
    if (ar === "adaptive") shape = `<span class="ar-shape ar-auto" style="width:16px;height:16px"></span>`;
    else { const [a, b] = ar.split(":").map(Number); const mx = Math.max(a, b), w = 20 * a / mx, h = 20 * b / mx; shape = `<span class="ar-shape" style="width:${w}px;height:${h}px"></span>`; }
    c.innerHTML = `${shape}<span>${ar === "adaptive" ? "AUTO" : ar}</span>`;
    c.onclick = () => { S().aspectRatio = ar; [...el.children].forEach((x) => x.classList.toggle("on", x === c)); updateCost(); };
    el.appendChild(c);
  }
}

function buildSwitches() {
  const m = M(), f = $("fieldSwitches"), box = $("switches");
  const sws = m.ui.switches || [];
  if (!sws.length) { f.style.display = "none"; box.innerHTML = ""; return; }
  f.style.display = ""; box.innerHTML = "";
  for (const sw of sws) {
    if (S().sw[sw.id] === undefined) S().sw[sw.id] = !!sw.default;
    const row = document.createElement("div"); row.className = "switch-row";
    const el = document.createElement("div"); el.className = "switch" + (S().sw[sw.id] ? " on" : "");
    el.onclick = () => { S().sw[sw.id] = !S().sw[sw.id]; el.classList.toggle("on"); updateCost(); };
    const lab = document.createElement("span"); lab.className = "lab"; lab.textContent = sw.label;
    row.append(el, lab);
    if (sw.help) { const h = document.createElement("span"); h.className = "help"; h.title = sw.help; h.textContent = "?"; row.appendChild(h); }
    box.appendChild(row);
  }
}

function renderPriceTable() {
  const m = M();
  if (m.pricingModel === "perSecond") {
    const pc = m.pricing.perSecond;
    let html;
    if (pc.byRes) {
      const hasAudioCols = Object.values(pc.byRes).some((v) => typeof v === "object");
      html = hasAudioCols
        ? "<tr><th>Разрешение</th><th>без звука</th><th>со звуком</th></tr>"
        : "<tr><th>Разрешение</th><th>за секунду</th></tr>";
      for (const [res, v] of Object.entries(pc.byRes)) {
        if (typeof v === "object") html += `<tr><td>${res}</td><td>$${(v.off ?? 0).toFixed(3)}/с</td><td>$${(v.on ?? 0).toFixed(3)}/с</td></tr>`;
        else html += hasAudioCols ? `<tr><td>${res}</td><td colspan="2">$${v.toFixed(3)}/с</td></tr>` : `<tr><td>${res}</td><td>$${v.toFixed(3)}/с</td></tr>`;
      }
    } else if (pc.secAudio != null) {
      html = "<tr><th>Тариф</th><th>за секунду</th></tr>" +
        `<tr><td>Без звука</td><td>$${pc.sec.toFixed(3)}/с</td></tr>` +
        `<tr><td>Со звуком</td><td>$${pc.secAudio.toFixed(3)}/с</td></tr>`;
    } else if (typeof pc.base === "number") {
      html = "<tr><th>Тариф (оценка)</th><th>значение</th></tr>" +
        (pc.base > 0 ? `<tr><td>База за клип</td><td>$${pc.base.toFixed(2)}</td></tr>` : "") +
        `<tr><td>За секунду</td><td>$${pc.sec.toFixed(2)}/с</td></tr>`;
    } else {
      html = "<tr><th>Разрешение</th><th>база за клип</th><th>за секунду</th></tr>";
      for (const [res, base] of Object.entries(pc.base)) html += `<tr><td>${res}</td><td>$${base.toFixed(2)}</td><td>$${pc.sec.toFixed(2)}/с</td></tr>`;
    }
    $("priceTable").innerHTML = html;
    $("priceNote").textContent = (m.pricing.note ? m.pricing.note + " " : "") + "Платишь по факту за секунды генерации, списание — по тарифу провайдера.";
  } else {
    const t = m.pricing.unitPerK[S().mode] || Object.values(m.pricing.unitPerK)[0];
    let html = "<tr><th>Разрешение</th><th>с видео</th><th>без видео</th></tr>";
    for (const [res, p] of Object.entries(t)) html += `<tr><td>${res}</td><td>$${(p.v * 1000).toFixed(2)}/1M</td><td>$${(p.nv * 1000).toFixed(2)}/1M</td></tr>`;
    $("priceTable").innerHTML = html;
    $("priceNote").textContent = "$/1M токенов · «с видео» — если приложен видео-реф (дешевле), иначе «без». Списание — по факту из ответа API.";
  }
}

// ── стоимость ───────────────────────────────────────────────
function estimate() {
  const m = M(), s = S();
  if (m.pricingModel === "perSecond") {
    const pc = m.pricing.perSecond;
    const base = typeof pc.base === "number" ? pc.base : (pc.base[s.resolution] ?? Object.values(pc.base)[0] ?? 0);
    const sec = perSecRate(pc, s.resolution, audioOn(m, s));
    const cost = base + sec * Number(s.duration);
    const label = base > 0
      ? `база $${base.toFixed(2)} + $${sec.toFixed(2)}/с × ${s.duration}с`
      : `$${sec.toFixed(2)}/с × ${s.duration}с`;
    return { model: "perSecond", cost, label };
  }
  const short = m.ui.shortSides[s.resolution] || 720;
  let factor = 16 / 9;
  if (s.aspectRatio !== "adaptive" && s.aspectRatio.includes(":")) { const [a, b] = s.aspectRatio.split(":").map(Number); factor = Math.max(a, b) / Math.min(a, b); }
  const tokens = Math.round(short * short * factor * m.fps * Number(s.duration) / 1024);
  const hasVid = s.refs.videos.length > 0;
  const u = m.pricing.unitPerK[s.mode]?.[s.resolution];
  const perK = u ? (hasVid ? u.v : u.nv) : 0.007;
  return { model: "tokens", tokens, cost: tokens / 1000 * perK, hasVid };
}
function updateCost() {
  const m = M(), e = estimate();
  if (e.model === "perSecond") {
    const hasAud = m.ui.audioNative || (m.ui.switches || []).some((x) => x.id === "audio" && S().sw[x.id]);
    $("costTok").textContent = "≈ " + e.label + (hasAud ? " · со звуком" : "");
  } else {
    $("costTok").textContent = "≈ " + e.tokens.toLocaleString("ru") + " ток. · " + (e.hasVid ? "с видео-рефом" : "без видео-входа");
  }
  $("costUsd").textContent = "≈ $" + e.cost.toFixed(2);
  // обновить ценники на чипах разрешений (зависят от длительности/формата/рефов)
  document.querySelectorAll("#resolution .chip").forEach((ch) => {
    const el = ch.querySelector(".res-price");
    if (el) el.textContent = resPriceHint(m, S(), ch.dataset.res);
  });
}

// ── референсы (используют активную вкладку) ─────────────────
// ужать крупную картинку прямо в браузере: провайдеры (особенно fal) давятся мега-base64 —
// оригинал 17 МБ давал у fal «Failed to load the image». Кап по большей стороне + пере-JPEG.
function downscaleImage(dataUrl, maxSide = 2048, quality = 0.9) {
  return new Promise((res) => {
    if (!/^data:image\//i.test(dataUrl)) return res(dataUrl); // http-URL или не картинка — как есть
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth, h = img.naturalHeight, scale = Math.min(1, maxSide / Math.max(w, h));
      if (scale >= 1 && dataUrl.length < 1_500_000) return res(dataUrl); // уже небольшая — не трогаем
      const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      const c = document.createElement("canvas"); c.width = cw; c.height = ch;
      c.getContext("2d").drawImage(img, 0, 0, cw, ch);
      try { res(c.toDataURL("image/jpeg", quality)); } catch { res(dataUrl); }
    };
    img.onerror = () => res(dataUrl);
    img.src = dataUrl;
  });
}
// читаем файлы, СОХРАНЯЯ порядок выбора (порядок важен: у Kling 1-я = старт, 2-я = финал; @Image1..N)
function readFiles(files, cb, isImg) {
  Promise.all([...files].map((f) => new Promise((res) => {
    const r = new FileReader();
    r.onload = async () => res(isImg ? await downscaleImage(r.result) : r.result);
    r.onerror = () => res(null);
    r.readAsDataURL(f);
  }))).then((results) => { for (const d of results) if (d) cb(d); });
}
const REFCFG = [
  ["img", "images", "inImg", "addImg", "thImg", "limImg", "@Image"],
  ["vid", "videos", "inVid", "addVid", "thVid", "limVid", "@Video"],
  ["aud", "audios", "inAud", "addAud", "thAud", "limAud", "@Audio"],
];
function addFiles(files, kind, key, thId, limId, addId, tag) {
  const limit = M().ui.refLimits[key]; if (!limit) return;
  const accept = kind === "img" ? "image/" : kind === "vid" ? "video/" : "audio/";
  const ok = [...files].filter((f) => !f.type || f.type.startsWith(accept));
  readFiles(ok, (d) => { const arr = S().refs[key]; if (arr.length < limit) { arr.push(d); renderRefs(kind, key, thId, limId, addId, tag); } }, kind === "img");
}
function setupRefs() {
  for (const [kind, key, inId, addId, thId, limId, tag] of REFCFG) {
    $(addId).onclick = () => $(inId).click();
    $(inId).onchange = (e) => { addFiles(e.target.files, kind, key, thId, limId, addId, tag); e.target.value = ""; };
    const Cap = kind[0].toUpperCase() + kind.slice(1);
    const rg = $("rg" + Cap);
    rg.addEventListener("dragover", (e) => { e.preventDefault(); rg.classList.add("drag"); });
    rg.addEventListener("dragleave", (e) => { if (!rg.contains(e.relatedTarget)) rg.classList.remove("drag"); });
    rg.addEventListener("drop", (e) => { e.preventDefault(); rg.classList.remove("drag"); addFiles(e.dataTransfer.files, kind, key, thId, limId, addId, tag); });
    const urlIn = $("url" + Cap);
    const addUrl = () => {
      const v = (urlIn.value || "").trim();
      if (!/^https?:\/\//i.test(v)) { alert("Вставь публичный URL (http/https)"); return; }
      const limit = M().ui.refLimits[key]; const arr = S().refs[key];
      if (limit && arr.length < limit) { arr.push(v); renderRefs(kind, key, thId, limId, addId, tag); urlIn.value = ""; }
    };
    rg.querySelector(".urladd").onclick = addUrl;
    urlIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } });
  }
}
function renderRefs(kind, key, thId, limId, addId, tag) {
  const limit = M().ui.refLimits[key] || 0;
  const arr = S().refs[key];
  const limEl = $(limId); limEl.textContent = `${arr.length}/${limit}` + (kind === "vid" ? " · ≤720p" : "") + (arr.length > limit ? " — лишние не отправятся" : "");
  limEl.style.color = arr.length > limit ? "var(--orange)" : "";
  $(addId).disabled = arr.length >= limit;
  const box = $(thId); box.innerHTML = "";
  arr.forEach((d, i) => {
    const t = document.createElement("div"); t.className = "thumb";
    const inner = kind === "img" ? `<img src="${d}">` : kind === "vid" ? `<video src="${d}" muted></video>` : `<div class="chip2">🎵 ${i + 1}</div>`;
    t.innerHTML = inner + `<div class="tag">${tag}${i + 1}</div><button class="x">×</button>`;
    t.querySelector(".x").onclick = () => { arr.splice(i, 1); renderRefs(kind, key, thId, limId, addId, tag); updateCost(); };
    box.appendChild(t);
  });
  updateCost();
}
// показать/скрыть группы рефов под активную модель + перерисовать
function refreshRefsUI() {
  const m = M(), kinds = m.ui.refKinds || [];
  $("rgImg").style.display = kinds.includes("img") ? "" : "none";
  $("rgVid").style.display = kinds.includes("vid") ? "" : "none";
  $("rgAud").style.display = kinds.includes("aud") ? "" : "none";
  const showAV = kinds.includes("vid") || kinds.includes("aud");
  $("refRowAV").style.display = showAV ? "" : "none";
  $("refsCard").style.display = kinds.length ? "" : "none";

  if (m.provider === "google") {
    $("specImg").textContent = "1–7 картинок · JPG·PNG·WEBP · 1 → кадр→видео, несколько → референс→видео";
    $("refsHint").innerHTML = "Omni берёт только картинки-рефы. Опиши в промпте, что с ними сделать. Звук модель добавит сама.";
  } else if (m.provider === "fal") {
    const lim = (m.ui.refLimits && m.ui.refLimits.images) || 0;
    $("specImg").textContent = (lim === 2
      ? "до 2 картинок: 1-я — стартовый кадр, 2-я — финальный"
      : "1 картинка → image-to-video") + " · JPG·PNG·WEBP · файлом или URL";
    $("refsHint").innerHTML = lim === 2
      ? "Kling: 1-я картинка — стартовый кадр, 2-я (опционально) — финальный. Опиши в промпте переход между ними."
      : "fal берёт одну картинку-реф для image-to-video (у моделей, где это есть). Опиши в промпте, что с ней сделать.";
  } else {
    $("specImg").textContent = "Ш×В 300–6000 px · ≤30 МБ · JPG·PNG·WEBP · можно файлом";
    if (CFG.tosEnabled) {
      const vs = $("rgVid").querySelector(".refspec"); if (vs) vs.innerHTML = "≤720p · ≤15 с · ≤50 МБ · MP4·MOV · файлом (TOS) или URL";
      const as = $("rgAud").querySelector(".refspec"); if (as) as.innerHTML = "≤15 с · ≤15 МБ · MP3·WAV · файлом (TOS) или URL";
      $("refsHint").innerHTML = "🟢 TOS включён: видео/аудио можно грузить файлом — сервер зальёт в TOS и подставит URL. В промпте: <b>@Image1 @Video1 @Audio1</b>";
    } else {
      $("refsHint").innerHTML = "Картинки — base64. Видео/аудио сервер зальёт на временный хостинг (~1ч) и подставит ссылку — или вставь свой URL. В промпте: <b>@Image1 @Video1 @Audio1</b>";
    }
  }
  for (const [kind, key, , addId, thId, limId, tag] of REFCFG) renderRefs(kind, key, thId, limId, addId, tag);
}

function setStatus(msg, cls = "") { const s = $("status"); s.className = "status " + cls; s.innerHTML = msg; }

// ── генерация ───────────────────────────────────────────────
function bindGen() {
  $("gen").onclick = async () => {
    const s = S(), m = M();
    const prompt = $("prompt").value.trim();
    if (!prompt) return setStatus("Введи промпт.", "err");
    if (!m.keyPresent) return setStatus(`Нет ключа для «${m.label}» — впиши ${m.apiKeyEnv} в .env и перезапусти сервер.`, "err");
    if (m.provider === "byteplus" && s.refs.audios.length && !s.refs.images.length && !s.refs.videos.length)
      return setStatus("Аудио-реф нельзя без картинки или видео-рефа — добавь хотя бы один кадр.", "err");
    // модели без text-to-video (напр. Kling 4K) требуют стартовый кадр
    if (m.ui.imageRequired && !(s.refs.images || []).length)
      return setStatus(`«${m._sub?.label || m.label}» — только кадр→видео: добавь стартовую картинку-реф ниже.`, "err");
    $("gen").disabled = true; // только на время отправки — чтобы один клик не задвоил задачу
    setStatus('<span class="spin"></span> Отправляю задачу…');
    const payload = {
      model: active, submodel: s.submodel, prompt,
      mode: s.mode, task: s.task,
      // шлём только то, что модель реально использует — иначе в карточке висят чужие теги (напр. 1080p/16:9 у Kling 4K)
      resolution: ((m.ui.resolutions && m.ui.resolutions.length) || m.ui.modes) ? s.resolution : undefined,
      aspectRatio: (m.ui.aspectRatios && m.ui.aspectRatios.length) ? s.aspectRatio : undefined,
      duration: Number(s.duration), seed: s.seed || undefined,
      audio: !!s.sw.audio, watermark: !!s.sw.watermark, returnLastFrame: !!s.sw.returnLastFrame,
      negativePrompt: m.ui.negative ? $("negative").value : undefined,
      cfgScale: m.ui.cfg ? Number($("cfg").value) : undefined,
      // шлём только рефы, которые текущая (под)модель реально принимает — остатки от другой подмодели не утекают
      images: (m.ui.refKinds || []).includes("img") ? s.refs.images.slice(0, m.ui.refLimits.images || 0) : [],
      videos: (m.ui.refKinds || []).includes("vid") ? s.refs.videos.slice(0, m.ui.refLimits.videos || 0) : [],
      audios: (m.ui.refKinds || []).includes("aud") ? s.refs.audios.slice(0, m.ui.refLimits.audios || 0) : [],
    };
    try {
      const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "ошибка");
      trackJob(data.jobId);   // задача ушла в фон — сразу можно ставить следующую (хоть с другой модели)
      loadGallery();
    } catch (e) { setStatus("Ошибка: " + e.message, "err"); }
    finally { $("gen").disabled = false; } // кнопка снова активна немедленно — параллельные задачи разрешены
  };
}

// ── параллельные задачи: несколько рендеров одновременно, каждый крутится в своей карточке ──
// сервер уже независим (у каждой задачи свой job id); двигает вперёд именно /api/job/{id},
// поэтому опрашиваем каждую активную задачу, а карточки обновляем общим loadGallery().
function trackJob(id) { activeJobs.add(id); startJobPoller(); updateActiveStatus(); }
function updateActiveStatus() {
  const n = activeJobs.size;
  setStatus(n ? `<span class="spin"></span> В работе: ${n} · можно ставить ещё` : "", n ? "" : "ok");
}
function startJobPoller() {
  if (jobTimer) return;
  jobTimer = setInterval(pollActive, 3000);
  pollActive();
}
async function pollActive() {
  if (!activeJobs.size) { clearInterval(jobTimer); jobTimer = null; return; }
  await Promise.all([...activeJobs].map(async (id) => {
    try {
      const st = await (await fetch("/api/job/" + encodeURIComponent(id))).json();
      if (st.state === "completed" || st.state === "failed") activeJobs.delete(id); // терминальное — снимаем с опроса
    } catch { /* сеть моргнула — повторим на следующем тике */ }
  }));
  loadGallery();          // карточки покажут актуальные статусы/готовые видео
  updateActiveStatus();
  if (!activeJobs.size) { clearInterval(jobTimer); jobTimer = null; }
}

// ── учёт расходов по движку (карточка «Счёт») ───────────────
function renderAccount(data) {
  const bm = (data.byModel && data.byModel[active]) || {};
  const spent = bm.spent || 0, budget = bm.budget, remaining = bm.remaining, count = bm.count || 0;
  const avg = count ? spent / count : 0;
  const remStr = remaining != null ? "$" + remaining.toFixed(2) : "$—";

  // топбар (сводка по всем движкам)
  $("spent").textContent = "$" + (data.totalSpent || 0).toFixed(2);
  $("genCount").textContent = data.count || 0;
  $("remaining").textContent = remStr;

  // карточка счёта активного движка
  $("acctSpent").textContent = "$" + spent.toFixed(2);
  $("acctRemaining").textContent = remStr;
  $("acctCount").innerHTML = count + (count ? ` <small>· ср. $${avg.toFixed(2)}</small>` : "");
  const bi = $("budget"); if (document.activeElement !== bi) bi.value = budget != null ? budget : "";

  // прогресс-бар + предупреждение об остатке
  const bar = $("acctBar"), warn = $("acctWarn");
  if (budget && budget > 0) {
    const pct = Math.min(100, Math.max(0, spent / budget * 100));
    bar.style.width = pct.toFixed(1) + "%";
    bar.className = "acct-bar-fill" + (remaining < 0 ? " over" : pct >= 80 ? " warn" : "");
    if (remaining < 0) { warn.className = "acct-warn over"; warn.textContent = "⚠ Превышен внесённый баланс на $" + Math.abs(remaining).toFixed(2) + " — пополни."; }
    else if (pct >= 80) { warn.className = "acct-warn warn"; warn.textContent = "⚠ Кредиты почти закончились — осталось " + Math.round(100 - pct) + "%."; }
    else { warn.className = "acct-warn ok"; warn.textContent = "Использовано " + Math.round(pct) + "% внесённого."; }
  } else {
    bar.style.width = "0%"; bar.className = "acct-bar-fill";
    warn.className = "acct-warn ok"; warn.textContent = "Впиши «Пополнено», чтобы видеть остаток и прогресс.";
  }

  // мини-сводка по всем движкам (есть на каждом экране)
  const others = $("acctOthers");
  const parts = ORDER.map((id) => {
    const b = (data.byModel && data.byModel[id]) || {};
    const rem = b.remaining != null ? " → ост. $" + b.remaining.toFixed(2) : "";
    return `<span class="ao${id === active ? " on" : ""}" data-id="${id}">${escapeHtml((b.label || MODELS[id]?.label || id))}: $${(b.spent || 0).toFixed(2)}${rem}</span>`;
  }).join("");
  others.innerHTML = `<span class="aolab">Все движки:</span> ${parts}`;
  others.querySelectorAll(".ao").forEach((el) => el.onclick = () => {
    const id = el.dataset.id; if (id === active) return;
    captureInputs(); active = id; renderModel();
  });
}

// ── общая лента результатов (все модели) ────────────────────
let gallerySig = null; // подпись содержимого — чтобы не пересобирать карточки (и не мигать превью) без изменений
async function loadGallery() {
  const data = await (await fetch("/api/history")).json();
  renderAccount(data);
  // подхватить незавершённые рендеры (напр. после перезапуска приложения) — пусть сами возобновят опрос
  for (const it of data.items) if (it.status === "pending" && !activeJobs.has(it.id)) trackJob(it.id);

  // пересобираем DOM только если реально что-то поменялось (id/статус/наличие видео/цена).
  // Иначе поллинг каждые 3 c пересоздавал <video>, и постер-кадр мигал.
  const sig = data.items.map((it) => `${it.id}:${it.status}:${it.hasVideo ? 1 : 0}:${it.cost ?? ""}`).join("|");
  if (sig === gallerySig) return;
  gallerySig = sig;

  const g = $("gallery");
  if (!data.items.length) { g.innerHTML = '<div class="empty">Пока пусто — сгенерируй первое видео.</div>'; return; }
  g.innerHTML = "";
  for (const it of data.items) {
    const pr = it.params || {};
    const media = it.hasVideo
      // #t=0.1 — медиа-фрагмент: браузер подтягивает кадр на 0.1 c и показывает его как превью/постер (иначе чёрный прямоугольник до запуска)
      ? `<video src="/api/media/${it.id}.mp4#t=0.1" controls loop playsinline preload="metadata"></video>`
      : `<div class="ph">${it.status === "pending" ? '<span class="spin"></span> рендер…' : "⚠ ошибка"}</div>`;
    const refStr = [it.refCounts.images && `🖼${it.refCounts.images}`, it.refCounts.videos && `🎬${it.refCounts.videos}`, it.refCounts.audios && `🎵${it.refCounts.audios}`].filter(Boolean).join(" ");
    const modelTag = `<span class="vtag model">${escapeHtml(it.modelLabel || it.model)}</span>`;
    const subLabel = pr.submodel && MODELS[it.model]?.submodels ? MODELS[it.model].submodels.find((s) => s.id === pr.submodel)?.label : null;
    const subTag = subLabel ? `<span class="vtag sub">${escapeHtml(subLabel)}</span>` : "";
    const tags = [pr.mode, pr.task && pr.task !== "auto" && pr.task, pr.resolution, pr.duration + "c", pr.aspectRatio, pr.audio && "🔊", pr.watermark && "©", refStr].filter(Boolean)
      .map((t) => `<span class="vtag">${t}</span>`).join("");
    const cost = it.cost != null ? `<span class="vtag cost">$${it.cost.toFixed(2)}</span>` : "";
    const date = new Date(it.createdAt).toLocaleString("ru");
    const card = document.createElement("div"); card.className = "vcard";
    card.innerHTML = media + `<div class="vinfo">
      <div class="vprompt">${escapeHtml(it.prompt)}</div>
      <div class="vmeta">${modelTag}${subTag}${tags}${cost}</div>
      <div class="vfoot"><span>${date}</span><div class="vacts">
        ${it.hasVideo ? `<a class="vbtn" href="/api/media/${it.id}.mp4" download>↓</a>` : ""}
        <button class="vbtn rep">↻ Повторить</button>
        <button class="vbtn del">🗑</button>
      </div></div></div>`;
    card.querySelector(".rep").onclick = () => repeat(it.id);
    card.querySelector(".del").onclick = () => del(it.id, it.prompt);
    g.appendChild(card);
  }
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function del(id, prompt) {
  if (!confirm("Удалить это видео и его данные безвозвратно?\n\n" + (prompt || "").slice(0, 80))) return;
  await fetch("/api/delete/" + encodeURIComponent(id), { method: "POST" });
  loadGallery();
}

async function repeat(id) {
  const e = await (await fetch("/api/entry/" + encodeURIComponent(id))).json();
  const mid = e.model && MODELS[e.model] ? e.model : active;
  const st = state[mid], m = MODELS[mid];
  st.prompt = e.prompt || "";
  if (e.params.mode) st.mode = e.params.mode;
  if (e.params.submodel) st.submodel = e.params.submodel;
  if (e.params.task) st.task = e.params.task;
  if (e.params.resolution) st.resolution = e.params.resolution;
  if (e.params.aspectRatio) st.aspectRatio = e.params.aspectRatio;
  if (e.params.duration) st.duration = e.params.duration;
  st.seed = e.params.seed || "";
  const pk = e.params.submodel || mid;
  if (e.params.negativePrompt != null) { st.negs = st.negs || {}; st.negs[pk] = e.params.negativePrompt; }
  if (e.params.cfgScale != null) { st.cfgs = st.cfgs || {}; st.cfgs[pk] = e.params.cfgScale; }
  st.sw = st.sw || {};
  const subUi = m.submodels ? (m.submodels.find((s) => s.id === st.submodel) || m.submodels[0]).ui : m.ui;
  for (const sw of (subUi.switches || [])) st.sw[sw.id] = !!e.params[sw.id];
  st.refs.images = e.refs.images || []; st.refs.videos = e.refs.videos || []; st.refs.audios = e.refs.audios || [];
  active = mid;
  renderModel();
  window.scrollTo({ top: 0, behavior: "smooth" });
  setStatus("Параметры и рефы подтянуты в «" + m.label + "» — жми «Сгенерировать».", "ok");
}

// ── внешний вид / интерфейс ─────────────────────────────────
const ACCENTS = [
  ["#0a84ff", "10,132,255", "Blue"], ["#00e5ff", "0,229,255", "HUD Cyan"], ["#39ff7a", "57,255,122", "Matrix"],
  ["#ffb000", "255,176,0", "Amber"], ["#ff3df0", "255,61,240", "Magenta"], ["#ff3b3b", "255,59,59", "Red Alert"],
];
const SK = "sd_skin", AK = "sd_accent", FK = "sd_fx", FS = "sd_fs";
function getFx() { try { return JSON.parse(localStorage.getItem(FK)) || { scanlines: true, grid: true, glow: true }; } catch { return { scanlines: true, grid: true, glow: true }; } }
function applyAppearance() {
  // «auto» (по умолчанию) следует за системной темой: светлая → белый скин, тёмная → Neural
  const pref = localStorage.getItem(SK) || "auto";
  const skin = pref === "auto" ? (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "neural") : pref;
  document.documentElement.setAttribute("data-skin", skin);
  document.querySelectorAll("#skinGroup button").forEach((b) => b.classList.toggle("on", b.dataset.skin === pref));
  $("hudFxField").style.display = skin === "neural" ? "" : "none";
  const root = document.documentElement;
  let acc = null; try { acc = JSON.parse(localStorage.getItem(AK)); } catch {}
  document.querySelectorAll("#accentSwatches .swatch").forEach((s) => s.classList.remove("active"));
  if (acc && acc.hex) {
    root.style.setProperty("--accent", acc.hex); root.style.setProperty("--accent-rgb", acc.rgb);
    const sw = document.querySelector(`#accentSwatches .swatch[data-hex="${acc.hex}"]`); if (sw) sw.classList.add("active");
  } else { root.style.removeProperty("--accent"); root.style.removeProperty("--accent-rgb"); }
  const fx = getFx();
  ["scanlines", "grid", "glow"].forEach((k) => {
    document.body.classList.toggle("fx-" + k, !!fx[k]);
    const sw = document.querySelector(`.switch[data-fx="${k}"]`); if (sw) sw.classList.toggle("on", !!fx[k]);
  });
  const fs = Number(localStorage.getItem(FS) || 100);
  document.querySelector(".wrap").style.zoom = fs / 100;
  $("fontSize").value = fs; $("fsVal").textContent = fs + "%";
  const cs = Number(localStorage.getItem("sd_card") || 340);
  document.documentElement.style.setProperty("--gallery-min", cs + "px");
  $("cardSize").value = cs; $("cardVal").textContent = cs + "px";
}
function setupAppearance() {
  const sw = $("accentSwatches");
  for (const [hex, rgb, title] of ACCENTS) {
    const s = document.createElement("span"); s.className = "swatch"; s.style.setProperty("--sw", hex);
    s.dataset.hex = hex; s.dataset.rgb = rgb; s.title = title;
    s.onclick = () => { if (s.classList.contains("active")) localStorage.removeItem(AK); else localStorage.setItem(AK, JSON.stringify({ hex, rgb })); applyAppearance(); };
    sw.appendChild(s);
  }
  $("skinGroup").querySelectorAll("button").forEach((b) => b.onclick = () => { localStorage.setItem(SK, b.dataset.skin); applyAppearance(); });
  // в режиме «Авто» перекрашиваемся сразу при смене системной темы
  matchMedia("(prefers-color-scheme: light)").addEventListener("change", applyAppearance);
  // страховка для WebView: если смена темы случилась, пока окно было в фоне
  window.addEventListener("focus", applyAppearance);
  document.querySelectorAll(".switch[data-fx]").forEach((el) => el.onclick = () => { const fx = getFx(); const k = el.dataset.fx; fx[k] = !fx[k]; localStorage.setItem(FK, JSON.stringify(fx)); applyAppearance(); });
  $("fontSize").oninput = () => { localStorage.setItem(FS, $("fontSize").value); applyAppearance(); };
  $("cardSize").oninput = () => { localStorage.setItem("sd_card", $("cardSize").value); applyAppearance(); };
  const drawer = (o) => { $("apprPanel").classList.toggle("open", o); $("apprOverlay").classList.toggle("open", o); };
  $("apprBtn").onclick = () => drawer(!$("apprPanel").classList.contains("open"));
  $("apprClose").onclick = () => drawer(false);
  $("apprOverlay").onclick = () => drawer(false);
  const updDrawer = (o) => { $("updPanel").classList.toggle("open", o); $("updOverlay").classList.toggle("open", o); };
  $("updBtn").onclick = () => { updDrawer(true); if (UPD_CACHE) renderUpdateReport(UPD_CACHE); else runUpdateCheck(); };
  $("updClose").onclick = () => updDrawer(false);
  $("updOverlay").onclick = () => updDrawer(false);
  $("updRun").onclick = () => runUpdateCheck();
  $("budget").onchange = async () => { await fetch("/api/budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: active, budget: Number($("budget").value) || 0 }) }); loadGallery(); };
  applyAppearance();
}

// ── актуальность моделей: сверка config.json с живыми схемами API ──
let UPD_CACHE = null;
const UPD_ICON = { ok: "✅", warn: "⚠️", update: "🆕", outdated: "⛔", error: "⛔", skip: "➖", manual: "✋" };
function updHasNews(rep) {
  return (rep.fal || []).some((x) => x.status !== "ok") || (rep.omni && !["ok", "skip"].includes(rep.omni.status));
}
function markUpdBtn(rep) { $("updBtn").classList.toggle("attn", updHasNews(rep)); }
async function runUpdateCheck() {
  const box = $("updResults");
  box.innerHTML = '<div class="upd-stamp"><span class="spin"></span> Опрашиваю fal и Google — секунд десять…</div>';
  try {
    const r = await fetch("/api/check-updates");
    const rep = await r.json();
    if (!r.ok) throw new Error(rep.error || "ошибка сервера");
    UPD_CACHE = rep;
    localStorage.setItem("updCheckAt", String(Date.now()));
    renderUpdateReport(rep); markUpdBtn(rep);
  } catch (e) { box.innerHTML = `<div class="upd-stamp">Ошибка проверки: ${escapeHtml(e.message)}</div>`; }
}
function renderUpdateReport(rep) {
  let html = `<div class="upd-stamp">Проверено: ${new Date(rep.checkedAt).toLocaleString("ru")}</div>`;
  for (const e of rep.fal || []) {
    html += `<div class="upd-item"><div class="upd-name">${UPD_ICON[e.status] || "·"} ${escapeHtml(e.label)}</div>` +
      `<div class="upd-ep">${escapeHtml(e.endpoint)}</div>`;
    const li = [
      ...(e.issues || []).map((i) => `<li>${escapeHtml(i)}</li>`),
      ...(e.newer || []).map((n) => `<li class="new">вышла новее: ${escapeHtml(n)}</li>`),
    ];
    if (li.length) html += `<ul>${li.join("")}</ul>`;
    html += `</div>`;
  }
  if (rep.omni) {
    html += `<div class="upd-item"><div class="upd-name">${UPD_ICON[rep.omni.status] || "·"} Google Omni</div>` +
      (rep.omni.model ? `<div class="upd-ep">${escapeHtml(rep.omni.model)}</div>` : "") +
      `<ul><li>${escapeHtml(rep.omni.note || "")}</li>${(rep.omni.candidates || []).map((c) => `<li>доступна также: ${escapeHtml(c)}</li>`).join("")}</ul></div>`;
  }
  if (rep.byteplus) {
    html += `<div class="upd-item"><div class="upd-name">✋ Seedance (BytePlus)</div>` +
      `<ul><li>${escapeHtml(rep.byteplus.note)}</li><li><a href="${rep.byteplus.url}" target="_blank" rel="noopener">Открыть консоль BytePlus</a></li></ul></div>`;
  }
  $("updResults").innerHTML = html;
}
// раз в сутки — тихая фоновая сверка; при находках подсвечиваем кнопку «Модели»
function autoUpdateCheck() {
  if (Date.now() - Number(localStorage.getItem("updCheckAt") || 0) < 864e5) return;
  fetch("/api/check-updates").then((r) => r.json()).then((rep) => {
    if (!rep || !rep.fal) return;
    UPD_CACHE = rep;
    localStorage.setItem("updCheckAt", String(Date.now()));
    markUpdBtn(rep);
  }).catch(() => {});
}

// промпт: авто-высота под текст + запоминаем ручное растягивание, пишем в состояние вкладки
function growPrompt() {
  const pt = $("prompt");
  pt.style.height = "auto";
  pt.style.height = Math.max(pt.scrollHeight, pt._floor || 0) + "px";
}
function setupPrompt() {
  const pt = $("prompt");
  pt.addEventListener("input", () => { S().prompt = pt.value; growPrompt(); });
  pt.addEventListener("mouseup", () => { pt._floor = pt.offsetHeight; });
  window.addEventListener("resize", growPrompt);
  growPrompt();
}

(async function () { await init(); })();
