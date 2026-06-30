const $ = (id) => document.getElementById(id);
let CFG = null, polling = null;
const refs = { images: [], videos: [], audios: [] };
const sel = { mode: null, resolution: null, aspectRatio: null };
const RES_META = { "480p": { tag: "SD", scale: .45 }, "720p": { tag: "HD", scale: .62 }, "1080p": { tag: "FHD", scale: .82 }, "4k": { tag: "4K", scale: 1 } };

async function init() {
  CFG = await (await fetch("/api/config")).json();
  $("provBadge").textContent = CFG.providerLabel;
  $("buyBtn").href = CFG.purchaseUrl;
  sel.mode = CFG.defaults.mode; sel.resolution = CFG.defaults.resolution; sel.aspectRatio = CFG.defaults.aspectRatio;

  buildModes(); buildResolutions(); buildAspects();
  $("duration").min = CFG.ui.durationMin; $("duration").max = CFG.ui.durationMax; $("duration").value = CFG.defaults.duration;
  $("durVal").textContent = $("duration").value + " c";
  $("duration").addEventListener("input", () => { $("durVal").textContent = $("duration").value + " c"; updateCost(); });

  setupSwitch("sw-audio", CFG.defaults.audio);
  setupSwitch("sw-watermark", CFG.defaults.watermark);
  setupSwitch("sw-returnLastFrame", CFG.defaults.returnLastFrame);

  renderPriceTable(); updateCost(); loadGallery();

  // если TOS настроен — видео/аудио можно грузить файлом (сервер зальёт в TOS)
  if (CFG.tosEnabled) {
    const vs = $("rgVid").querySelector(".refspec"); if (vs) vs.innerHTML = "≤720p · ≤15 с · ≤50 МБ · MP4·MOV · файлом (TOS) или URL";
    const as = $("rgAud").querySelector(".refspec"); if (as) as.innerHTML = "≤15 с · ≤15 МБ · MP3·WAV · файлом (TOS) или URL";
    const h = $("refsHint"); if (h) h.innerHTML = "🟢 TOS-заливка включена: видео/аудио можно грузить файлом — сервер сам зальёт в TOS и подставит URL. Тело ≤64 МБ. В промпте: <b>@Image1 @Video1 @Audio1</b>";
  }
}

function buildModes() {
  const el = $("mode"); el.innerHTML = "";
  for (const m of CFG.ui.modes) {
    const b = document.createElement("button"); b.textContent = m.label;
    if (m.id === sel.mode) b.classList.add("on");
    b.onclick = () => { sel.mode = m.id; [...el.children].forEach(c => c.classList.toggle("on", c === b)); buildResolutions(); renderPriceTable(); updateCost(); };
    el.appendChild(b);
  }
}

function buildResolutions() {
  const list = CFG.ui.resolutionsByMode[sel.mode] || ["480p", "720p"];
  if (!list.includes(sel.resolution)) sel.resolution = list[Math.min(1, list.length - 1)];
  const el = $("resolution"); el.innerHTML = "";
  for (const r of list) {
    const m = RES_META[r] || { tag: "", scale: .6 };
    const c = document.createElement("div"); c.className = "chip" + (r === sel.resolution ? " on" : "");
    c.innerHTML = `<span class="res-box"><i style="height:${Math.round(m.scale * 18)}px"></i></span><b>${r}</b><span class="res-tag">${m.tag}</span>`;
    c.onclick = () => { sel.resolution = r; [...el.children].forEach(x => x.classList.toggle("on", x === c)); updateCost(); };
    el.appendChild(c);
  }
}

function buildAspects() {
  const el = $("aspectRatio"); el.innerHTML = "";
  for (const ar of CFG.ui.aspectRatios) {
    const c = document.createElement("div"); c.className = "chip" + (ar === sel.aspectRatio ? " on" : "");
    let shape;
    if (ar === "adaptive") shape = `<span class="ar-shape ar-auto" style="width:16px;height:16px"></span>`;
    else {
      const [a, b] = ar.split(":").map(Number); const mx = Math.max(a, b), w = 20 * a / mx, h = 20 * b / mx;
      shape = `<span class="ar-shape" style="width:${w}px;height:${h}px"></span>`;
    }
    c.innerHTML = `${shape}<span>${ar === "adaptive" ? "AUTO" : ar}</span>`;
    c.onclick = () => { sel.aspectRatio = ar; [...el.children].forEach(x => x.classList.toggle("on", x === c)); updateCost(); };
    el.appendChild(c);
  }
}

function setupSwitch(id, on) {
  const el = $(id); el.classList.toggle("on", !!on);
  el.onclick = () => { el.classList.toggle("on"); updateCost(); };
}
const swOn = (id) => $(id).classList.contains("on");

function renderPriceTable() {
  const t = CFG.pricing.unitPerK[sel.mode];
  let html = "<tr><th>Разрешение</th><th>с видео</th><th>без видео</th></tr>";
  for (const [res, p] of Object.entries(t)) html += `<tr><td>${res}</td><td>$${(p.v * 1000).toFixed(2)}/1M</td><td>$${(p.nv * 1000).toFixed(2)}/1M</td></tr>`;
  $("priceTable").innerHTML = html;
}

// ── стоимость ───────────────────────────────────────────────
function estimate() {
  const short = CFG.ui.shortSides[sel.resolution] || 720;
  let factor = 16 / 9;
  if (sel.aspectRatio !== "adaptive" && sel.aspectRatio.includes(":")) { const [a, b] = sel.aspectRatio.split(":").map(Number); factor = Math.max(a, b) / Math.min(a, b); }
  const tokens = Math.round(short * short * factor * CFG.fps * Number($("duration").value) / 1024);
  const hasVid = refs.videos.length > 0;
  const u = CFG.pricing.unitPerK[sel.mode]?.[sel.resolution];
  const perK = u ? (hasVid ? u.v : u.nv) : 0.007;
  return { tokens, cost: tokens / 1000 * perK, hasVid };
}
function updateCost() {
  const { tokens, cost, hasVid } = estimate();
  $("costTok").textContent = "≈ " + tokens.toLocaleString("ru") + " ток. · " + (hasVid ? "с видео-рефом" : "без видео-входа");
  $("costUsd").textContent = "≈ $" + cost.toFixed(2);
}

// ── референсы ───────────────────────────────────────────────
function readFiles(files, cb) { for (const f of files) { const r = new FileReader(); r.onload = () => cb(r.result); r.readAsDataURL(f); } }
const REFCFG = [
  ["img", "images", "inImg", "addImg", "thImg", "limImg", "@Image"],
  ["vid", "videos", "inVid", "addVid", "thVid", "limVid", "@Video"],
  ["aud", "audios", "inAud", "addAud", "thAud", "limAud", "@Audio"],
];
function addFiles(files, kind, key, thId, limId, addId, tag) {
  const limit = CFG.ui.refLimits[key];
  const accept = kind === "img" ? "image/" : kind === "vid" ? "video/" : "audio/";
  const ok = [...files].filter(f => !f.type || f.type.startsWith(accept));
  readFiles(ok, (d) => { if (refs[key].length < limit) { refs[key].push(d); renderRefs(kind, key, thId, limId, addId, tag); } });
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
      if (refs[key].length < CFG.ui.refLimits[key]) { refs[key].push(v); renderRefs(kind, key, thId, limId, addId, tag); urlIn.value = ""; }
    };
    rg.querySelector(".urladd").onclick = addUrl;
    urlIn.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } });
    renderRefs(kind, key, thId, limId, addId, tag);
  }
}
function renderRefs(kind, key, thId, limId, addId, tag) {
  const limit = CFG.ui.refLimits[key];
  const limEl = $(limId); limEl.textContent = `${refs[key].length}/${limit}` + (kind === "vid" ? " · ≤720p" : "");
  $(addId).disabled = refs[key].length >= limit;
  const box = $(thId); box.innerHTML = "";
  refs[key].forEach((d, i) => {
    const t = document.createElement("div"); t.className = "thumb";
    let inner = kind === "img" ? `<img src="${d}">` : kind === "vid" ? `<video src="${d}" muted></video>` : `<div class="chip2">🎵 ${i + 1}</div>`;
    t.innerHTML = inner + `<div class="tag">${tag}${i + 1}</div><button class="x">×</button>`;
    t.querySelector(".x").onclick = () => { refs[key].splice(i, 1); renderRefs(kind, key, thId, limId, addId, tag); updateCost(); };
    box.appendChild(t);
  });
  updateCost();
}

function setStatus(msg, cls = "") { const s = $("status"); s.className = "status " + cls; s.innerHTML = msg; }

// ── генерация ───────────────────────────────────────────────
function bindGen() {
  $("gen").onclick = async () => {
    const prompt = $("prompt").value.trim();
    if (!prompt) return setStatus("Введи промпт.", "err");
    if (refs.audios.length && !refs.images.length && !refs.videos.length)
      return setStatus("Аудио-реф нельзя без картинки или видео-рефа — добавь хотя бы один кадр.", "err");
    if (polling) clearInterval(polling);
    $("gen").disabled = true;
    setStatus('<span class="spin"></span> Отправляю задачу…');
    const payload = {
      prompt, mode: sel.mode, resolution: sel.resolution, aspectRatio: sel.aspectRatio,
      duration: Number($("duration").value), audio: swOn("sw-audio"), watermark: swOn("sw-watermark"),
      returnLastFrame: swOn("sw-returnLastFrame"), seed: $("seed").value || undefined,
      images: refs.images, videos: refs.videos, audios: refs.audios,
    };
    try {
      const r = await fetch("/api/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "ошибка");
      loadGallery();
      pollJob(data.jobId);
    } catch (e) { $("gen").disabled = false; setStatus("Ошибка: " + e.message, "err"); }
  };
}
function pollJob(jobId) {
  const started = Date.now();
  setStatus('<span class="spin"></span> Рендер… (0c)');
  polling = setInterval(async () => {
    const sec = Math.round((Date.now() - started) / 1000);
    try {
      const st = await (await fetch("/api/job/" + encodeURIComponent(jobId))).json();
      if (st.state === "completed") {
        clearInterval(polling); polling = null; $("gen").disabled = false;
        const c = st.cost != null ? ` · $${st.cost.toFixed(2)} (${(st.tokens || 0).toLocaleString("ru")} ток.)` : "";
        setStatus("Готово за " + sec + "c" + c, "ok"); loadGallery();
      } else if (st.state === "failed") {
        clearInterval(polling); polling = null; $("gen").disabled = false;
        setStatus("Не удалось: " + (st.error || "unknown"), "err"); loadGallery();
      } else { setStatus('<span class="spin"></span> Рендер… (' + sec + "c)"); loadGallery(); }
    } catch (e) { clearInterval(polling); polling = null; $("gen").disabled = false; setStatus("Ошибка: " + e.message, "err"); }
  }, 3000);
}

// ── галерея результатов ─────────────────────────────────────
async function loadGallery() {
  const data = await (await fetch("/api/history")).json();
  $("spent").textContent = "$" + (data.totalSpent || 0).toFixed(2);
  $("genCount").textContent = data.count || 0;
  const remStr = data.remaining != null ? "$" + data.remaining.toFixed(2) : "$—";
  $("remaining").textContent = remStr;
  if ($("remaining2")) $("remaining2").textContent = remStr;
  if ($("spent2")) $("spent2").textContent = "потрачено $" + (data.totalSpent || 0).toFixed(2) + " · " + (data.count || 0) + " ген.";
  const bi = $("budget"); if (document.activeElement !== bi && data.budget != null && bi.value === "") bi.value = data.budget;
  const g = $("gallery");
  if (!data.items.length) { g.innerHTML = '<div class="empty">Пока пусто — сгенерируй первое видео.</div>'; return; }
  g.innerHTML = "";
  for (const it of data.items) {
    const pr = it.params || {};
    const media = it.hasVideo
      ? `<video src="/api/media/${it.id}.mp4" controls loop preload="metadata"></video>`
      : `<div class="ph">${it.status === "pending" ? '<span class="spin"></span> рендер…' : "⚠ ошибка"}</div>`;
    const refStr = [it.refCounts.images && `🖼${it.refCounts.images}`, it.refCounts.videos && `🎬${it.refCounts.videos}`, it.refCounts.audios && `🎵${it.refCounts.audios}`].filter(Boolean).join(" ");
    const tags = [pr.mode || pr.tier, pr.resolution, pr.duration + "c", pr.aspectRatio, pr.audio && "🔊", pr.watermark && "©", refStr].filter(Boolean)
      .map(t => `<span class="vtag">${t}</span>`).join("");
    const cost = it.cost != null ? `<span class="vtag cost">$${it.cost.toFixed(2)}</span>` : "";
    const date = new Date(it.createdAt).toLocaleString("ru");
    const card = document.createElement("div"); card.className = "vcard";
    card.innerHTML = media + `<div class="vinfo">
      <div class="vprompt">${escapeHtml(it.prompt)}</div>
      <div class="vmeta">${tags}${cost}</div>
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
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

async function del(id, prompt) {
  if (!confirm("Удалить это видео и его данные безвозвратно?\n\n" + (prompt || "").slice(0, 80))) return;
  await fetch("/api/delete/" + encodeURIComponent(id), { method: "POST" });
  loadGallery();
}

async function repeat(id) {
  const e = await (await fetch("/api/entry/" + encodeURIComponent(id))).json();
  $("prompt").value = e.prompt;
  if (typeof growPrompt === "function") growPrompt();
  if (e.params.mode) { sel.mode = e.params.mode; buildModes(); }
  buildResolutions(); if (e.params.resolution && (CFG.ui.resolutionsByMode[sel.mode] || []).includes(e.params.resolution)) { sel.resolution = e.params.resolution; buildResolutions(); }
  if (e.params.aspectRatio) { sel.aspectRatio = e.params.aspectRatio; buildAspects(); }
  $("duration").value = e.params.duration; $("durVal").textContent = e.params.duration + " c";
  $("seed").value = e.params.seed || "";
  $("sw-audio").classList.toggle("on", !!e.params.audio);
  $("sw-watermark").classList.toggle("on", !!e.params.watermark);
  $("sw-returnLastFrame").classList.toggle("on", !!e.params.returnLastFrame);
  refs.images = e.refs.images || []; refs.videos = e.refs.videos || []; refs.audios = e.refs.audios || [];
  for (const [kind, key, , addId, thId, limId, tag] of REFCFG) renderRefs(kind, key, thId, limId, addId, tag);
  renderPriceTable(); updateCost();
  window.scrollTo({ top: 0, behavior: "smooth" });
  setStatus("Параметры и рефы подтянуты — жми «Сгенерировать».", "ok");
}

// ── внешний вид / интерфейс ─────────────────────────────────
const ACCENTS = [
  ["#0a84ff", "10,132,255", "Blue"], ["#00e5ff", "0,229,255", "HUD Cyan"], ["#39ff7a", "57,255,122", "Matrix"],
  ["#ffb000", "255,176,0", "Amber"], ["#ff3df0", "255,61,240", "Magenta"], ["#ff3b3b", "255,59,59", "Red Alert"],
];
const SK = "sd_skin", AK = "sd_accent", FK = "sd_fx", FS = "sd_fs";
function getFx() { try { return JSON.parse(localStorage.getItem(FK)) || { scanlines: true, grid: true, glow: true }; } catch { return { scanlines: true, grid: true, glow: true }; } }
function applyAppearance() {
  const skin = localStorage.getItem(SK) || "neural";
  document.documentElement.setAttribute("data-skin", skin);
  document.querySelectorAll("#skinGroup button").forEach(b => b.classList.toggle("on", b.dataset.skin === skin));
  $("hudFxField").style.display = skin === "neural" ? "" : "none";
  const root = document.documentElement;
  let acc = null; try { acc = JSON.parse(localStorage.getItem(AK)); } catch {}
  document.querySelectorAll("#accentSwatches .swatch").forEach(s => s.classList.remove("active"));
  if (acc && acc.hex) {
    root.style.setProperty("--accent", acc.hex); root.style.setProperty("--accent-rgb", acc.rgb);
    const sw = document.querySelector(`#accentSwatches .swatch[data-hex="${acc.hex}"]`); if (sw) sw.classList.add("active");
  } else { root.style.removeProperty("--accent"); root.style.removeProperty("--accent-rgb"); }
  const fx = getFx();
  ["scanlines", "grid", "glow"].forEach(k => {
    document.body.classList.toggle("fx-" + k, !!fx[k]);
    const sw = document.querySelector(`.switch[data-fx="${k}"]`); if (sw) sw.classList.toggle("on", !!fx[k]);
  });
  const fs = Number(localStorage.getItem(FS) || 100);
  document.querySelector(".wrap").style.zoom = fs / 100;
  $("fontSize").value = fs; $("fsVal").textContent = fs + "%";
  const cs = Number(localStorage.getItem("sd_card") || 280);
  document.documentElement.style.setProperty("--gallery-min", cs + "px");
  $("cardSize").value = cs; $("cardVal").textContent = cs + "px";
}
function setupAppearance() {
  const sw = $("accentSwatches");
  for (const [hex, rgb, title] of ACCENTS) {
    const s = document.createElement("span"); s.className = "swatch"; s.style.setProperty("--sw", hex);
    s.dataset.hex = hex; s.dataset.rgb = rgb; s.title = title;
    s.onclick = () => {
      if (s.classList.contains("active")) localStorage.removeItem(AK);
      else localStorage.setItem(AK, JSON.stringify({ hex, rgb }));
      applyAppearance();
    };
    sw.appendChild(s);
  }
  $("skinGroup").querySelectorAll("button").forEach(b => b.onclick = () => { localStorage.setItem(SK, b.dataset.skin); applyAppearance(); });
  document.querySelectorAll(".switch[data-fx]").forEach(el => el.onclick = () => { const fx = getFx(); const k = el.dataset.fx; fx[k] = !fx[k]; localStorage.setItem(FK, JSON.stringify(fx)); applyAppearance(); });
  $("fontSize").oninput = () => { localStorage.setItem(FS, $("fontSize").value); applyAppearance(); };
  $("cardSize").oninput = () => { localStorage.setItem("sd_card", $("cardSize").value); applyAppearance(); };
  const drawer = (o) => { $("apprPanel").classList.toggle("open", o); $("apprOverlay").classList.toggle("open", o); };
  $("apprBtn").onclick = () => drawer(!$("apprPanel").classList.contains("open"));
  $("apprClose").onclick = () => drawer(false);
  $("apprOverlay").onclick = () => drawer(false);
  $("budget").onchange = async () => { await fetch("/api/budget", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budget: Number($("budget").value) || 0 }) }); loadGallery(); };
  applyAppearance();
}

// промпт: авто-высота под текст (не прячет содержимое) + ручное растягивание
function growPrompt() {
  const pt = $("prompt");
  pt.style.height = "auto";
  pt.style.height = Math.max(pt.scrollHeight, pt._floor || 0) + "px";
}
function setupPrompt() {
  const pt = $("prompt");
  pt.addEventListener("input", growPrompt);
  pt.addEventListener("mouseup", () => { pt._floor = pt.offsetHeight; }); // запомнить ручное растягивание
  window.addEventListener("resize", growPrompt);
  growPrompt();
}

(async function () { await init(); setupRefs(); bindGen(); setupAppearance(); setupPrompt(); })();
