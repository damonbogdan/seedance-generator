// Локальный сервер генератора видео. Мультимодельный: несколько движков (Seedance/Google Omni),
// у каждого свой ключ, свои настройки и цены, но общее локальное хранилище и общая лента результатов.
// Ключи живут только здесь и в браузер не попадают.
import http from "node:http";
import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { buildClient } from "./seedanceClient.mjs";
import { tosConfigured, uploadAndPresign } from "./tosUpload.mjs";
import { uploadTemp } from "./tempUpload.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const f = path.join(__dirname, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv();

const config = JSON.parse(readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PORT = Number(process.env.PORT || 5178);

const STORAGE = config.storageDir.replace(/^~/, os.homedir());
await mkdir(STORAGE, { recursive: true });

// ── модели: собираем клиента для каждой (у кого есть ключ) ─────────────────────
const MODELS = config.models;
const byId = new Map(MODELS.map((m) => [m.id, m]));
const clients = new Map();
for (const m of MODELS) {
  const key = process.env[m.apiKeyEnv] || "";
  if (key) { try { clients.set(m.id, buildClient({ apiKey: key, model: m })); } catch (e) { console.error(`Модель ${m.id}: ${e.message}`); } }
  else console.warn(`Модель ${m.label}: нет ключа ${m.apiKeyEnv} в .env — вкладка будет видна, но генерация выключена.`);
}
const keyPresent = (id) => clients.has(id);
if (!clients.size) console.error("Ни у одной модели нет ключа — впиши ключи в .env.");

// записать/заменить переменную в .env (сохраняя остальные строки)
async function setEnvVar(name, value) {
  const f = path.join(__dirname, ".env");
  let text = "";
  try { text = readFileSync(f, "utf8"); } catch {}
  const line = `${name}=${value}`;
  const re = new RegExp(`^\\s*${name}\\s*=.*$`, "m");
  if (re.test(text)) text = text.replace(re, () => line);
  else text = text.replace(/\s*$/, "") + `\n${line}\n`;
  await writeFile(f, text);
}

const BUDGET_FILE = path.join(STORAGE, "budget.json");
async function getBudgets() {
  try {
    const j = JSON.parse(await readFile(BUDGET_FILE, "utf8"));
    if (typeof j.budget === "number") return { [config.defaultModel]: j.budget }; // back-compat со старым форматом
    return j || {};
  } catch { return {}; }
}

// ── helpers ──────────────────────────────────────────────────────────────────
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".png": "image/png", ".jpg": "image/jpeg",
  ".webp": "image/webp", ".mp3": "audio/mpeg", ".wav": "audio/wav",
};
const EXT_BY_MIME = {
  "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp",
  "video/mp4": "mp4", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/wav": "wav",
};

function send(res, code, body, type = "application/json") {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(data);
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}
function dataUrlToBuffer(dataUrl) {
  const m = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/s);
  if (!m) return null;
  return { mime: m[1], ext: EXT_BY_MIME[m[1]] || "bin", buf: Buffer.from(m[2], "base64") };
}
const metaPath = (id) => path.join(STORAGE, id + ".json");
async function saveMeta(meta) { await writeFile(metaPath(meta.id), JSON.stringify(meta, null, 2)); }
async function loadMeta(id) { return JSON.parse(await readFile(metaPath(id), "utf8")); }

// стоимость по тарифной модели конкретного движка (для fal — по выбранной подмодели)
function costOf(model, params, tokens) {
  let pricing = model.pricing, pricingModel = model.pricingModel;
  if (model.submodels) {
    const sub = model.submodels.find((s) => s.id === params.submodel) || model.submodels[0];
    pricing = sub.pricing; pricingModel = sub.pricingModel || model.pricingModel;
  }
  if (pricingModel === "perSecond") {
    const pc = pricing.perSecond || {};
    const base = typeof pc.base === "number" ? pc.base : (pc.base?.[params.resolution] ?? Object.values(pc.base || {})[0] ?? 0);
    return +(base + (pc.sec || 0) * Number(params.duration || 0)).toFixed(4);
  }
  // tokens (Seedance): считаем по факту usage из ответа API
  if (tokens == null) return null;
  const table = pricing.unitPerK || {};
  const m = table[params.mode] || table.pro || Object.values(table)[0] || {};
  const r = m[params.resolution] || m["720p"] || Object.values(m)[0] || { v: 0.007, nv: 0.007 };
  const perK = params.hasVideoInput ? r.v : r.nv;
  return +(tokens / 1000 * perK).toFixed(4);
}

async function fileToDataUrl(file) {
  const buf = await readFile(path.join(STORAGE, file));
  const mime = MIME[path.extname(file)] || "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// Видео/аудио для отправки в Ark: data:base64 нельзя — заливаем в TOS и берём presigned URL.
async function refsForSubmit(id, kind, list) {
  const out = [];
  let i = 1;
  for (const item of list || []) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) { out.push(item); i++; continue; }
    const d = dataUrlToBuffer(item);
    if (!d) continue;
    const filename = `${id}.${kind}${i}.${d.ext}`;
    const url = tosConfigured()
      ? await uploadAndPresign(d.buf, `seedance-refs/${filename}`, d.mime)
      : await uploadTemp(d.buf, filename, d.mime);
    out.push(url);
    i++;
  }
  return out;
}

// сохранить рефы на диск, вернуть [file|url]
async function persistRefs(id, kind, list) {
  const out = [];
  let i = 1;
  for (const item of list || []) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) { out.push(item); continue; }
    const d = dataUrlToBuffer(item);
    if (!d) continue;
    const file = `${id}.${kind}${i}.${d.ext}`;
    await writeFile(path.join(STORAGE, file), d.buf);
    out.push(file); i++;
  }
  return out;
}

// скачать готовое видео в локальное хранилище; вернуть true при успехе
async function downloadToStore(id, videoUrl) {
  const r = await fetch(videoUrl);
  if (!r.ok) throw new Error(`download ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  await writeFile(path.join(STORAGE, id + ".mp4"), buf);
  return true;
}

// публичный вид модели для фронта (без секретов)
function publicModel(m) {
  return {
    id: m.id, label: m.label, badge: m.badge, provider: m.provider,
    apiKeyEnv: m.apiKeyEnv, keyPresent: keyPresent(m.id),
    purchaseUrl: m.purchaseUrl, buyLabel: m.buyLabel, fps: m.fps,
    pricingModel: m.pricingModel, defaults: m.defaults, ui: m.ui, pricing: m.pricing,
    submodels: m.submodels || null,
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === "/api/config") {
      return send(res, 200, {
        defaultModel: config.defaultModel,
        models: MODELS.map(publicModel),
        storageDir: STORAGE,
        tosEnabled: tosConfigured(),
      });
    }

    if (p === "/api/generate" && req.method === "POST") {
      const b = await readJsonBody(req);
      const model = byId.get(b.model) || byId.get(config.defaultModel);
      if (!model) return send(res, 400, { error: "Неизвестная модель" });
      const client = clients.get(model.id);
      if (!client) return send(res, 400, { error: `Нет ключа для «${model.label}» — впиши ${model.apiKeyEnv} в .env` });
      if (!b.prompt || !String(b.prompt).trim()) return send(res, 400, { error: "Пустой промпт" });

      const id = "g_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const refs = {
        images: await persistRefs(id, "img", b.images),
        videos: await persistRefs(id, "vid", b.videos),
        audios: await persistRefs(id, "aud", b.audios),
      };
      const hasVideoInput = (b.videos || []).length > 0;
      const params = {
        mode: b.mode || null, submodel: b.submodel || null, resolution: b.resolution, duration: Number(b.duration),
        aspectRatio: b.aspectRatio, audio: !!b.audio, watermark: !!b.watermark,
        returnLastFrame: !!b.returnLastFrame, task: b.task || null, seed: b.seed || null, hasVideoInput,
      };

      // Seedance: видео/аудио через TOS presigned URL; картинки base64. Omni: только картинки.
      let submitVideos = [], submitAudios = [];
      if (model.provider === "byteplus") {
        submitVideos = await refsForSubmit(id, "vid", b.videos);
        submitAudios = await refsForSubmit(id, "aud", b.audios);
      }
      const sub = await client.submit({ prompt: b.prompt, ...params, images: b.images, videos: submitVideos, audios: submitAudios });

      const meta = { id, model: model.id, createdAt: Date.now(), status: "pending", prompt: b.prompt, params, refs, providerId: sub.providerId, tokens: null, cost: null };
      await saveMeta(meta);

      // синхронные движки (Omni) часто отдают готовое видео сразу — скачиваем не дожидаясь поллинга
      if (sub.ready?.videoUrl) {
        try {
          await downloadToStore(id, sub.ready.videoUrl);
          meta.status = "done"; meta.tokens = sub.ready.tokens || null;
          meta.cost = costOf(model, params, meta.tokens);
          meta.finishedAt = Date.now();
          await saveMeta(meta);
        } catch (e) { console.error("immediate download failed", e.message); } // останется pending — добьётся поллингом
      }
      return send(res, 200, { jobId: id });
    }

    if (p.startsWith("/api/job/")) {
      const id = decodeURIComponent(p.slice("/api/job/".length));
      let meta;
      try { meta = await loadMeta(id); } catch { return send(res, 404, { error: "Неизвестная задача" }); }
      const model = byId.get(meta.model) || byId.get(config.defaultModel);
      if (meta.status === "done")
        return send(res, 200, { state: "completed", videoUrl: `/api/media/${id}.mp4`, tokens: meta.tokens, cost: meta.cost });
      const client = clients.get(model.id);
      if (!client) return send(res, 200, { state: "failed", error: `нет ключа ${model.apiKeyEnv}` });
      const st = await client.status(meta.providerId);
      if (st.state === "completed") {
        let videoUrl = st.videoUrl;
        try { await downloadToStore(id, st.videoUrl); videoUrl = `/api/media/${id}.mp4`; }
        catch (e) { console.error("download failed", e.message); }
        meta.status = "done"; meta.tokens = st.tokens ?? meta.tokens ?? null;
        meta.cost = costOf(model, meta.params, meta.tokens);
        meta.finishedAt = Date.now();
        await saveMeta(meta);
        return send(res, 200, { state: "completed", videoUrl, tokens: meta.tokens, cost: meta.cost });
      }
      if (st.state === "failed") {
        meta.status = "failed"; meta.error = st.error; await saveMeta(meta);
        return send(res, 200, { state: "failed", error: st.error });
      }
      return send(res, 200, { state: "pending" });
    }

    if (p === "/api/history") {
      const files = (await readdir(STORAGE)).filter((f) => f.startsWith("g_") && f.endsWith(".json"));
      const metas = [];
      for (const f of files) { try { metas.push(JSON.parse(await readFile(path.join(STORAGE, f), "utf8"))); } catch {} }
      metas.sort((a, b) => b.createdAt - a.createdAt);
      const budgets = await getBudgets();
      const totalSpent = +metas.reduce((s, m) => s + (m.cost || 0), 0).toFixed(4);

      // сводка по каждой модели
      const byModel = {};
      for (const m of MODELS) byModel[m.id] = { label: m.label, spent: 0, count: 0, budget: budgets[m.id] ?? null, remaining: null };
      for (const m of metas) {
        const b = byModel[m.model] || byModel[config.defaultModel];
        if (b) { b.spent = +(b.spent + (m.cost || 0)).toFixed(4); b.count++; }
      }
      for (const id in byModel) { const b = byModel[id]; b.remaining = b.budget != null ? +(b.budget - b.spent).toFixed(2) : null; }

      const list = metas.map((m) => ({
        id: m.id, model: m.model || config.defaultModel, modelLabel: byId.get(m.model || config.defaultModel)?.label || m.model || config.defaultModel,
        createdAt: m.createdAt, status: m.status, prompt: m.prompt, params: m.params,
        tokens: m.tokens, cost: m.cost, error: m.error || null,
        hasVideo: existsSync(path.join(STORAGE, m.id + ".mp4")),
        refCounts: { images: m.refs?.images?.length || 0, videos: m.refs?.videos?.length || 0, audios: m.refs?.audios?.length || 0 },
      }));
      return send(res, 200, { totalSpent, count: list.length, items: list, byModel });
    }

    if (p === "/api/keys" && req.method === "POST") {
      const b = await readJsonBody(req);
      const model = byId.get(b.model);
      if (!model) return send(res, 400, { error: "Неизвестная модель" });
      const key = String(b.key || "").trim();
      await setEnvVar(model.apiKeyEnv, key);
      process.env[model.apiKeyEnv] = key;
      if (key) { try { clients.set(model.id, buildClient({ apiKey: key, model })); } catch (e) { return send(res, 500, { error: e.message }); } }
      else clients.delete(model.id);
      console.log(`Ключ ${model.apiKeyEnv} для «${model.label}» ${key ? "обновлён" : "очищен"} через UI`);
      return send(res, 200, { ok: true, keyPresent: keyPresent(model.id), apiKeyEnv: model.apiKeyEnv });
    }

    if (p === "/api/budget" && req.method === "POST") {
      const b = await readJsonBody(req);
      const budgets = await getBudgets();
      const modelId = byId.has(b.model) ? b.model : config.defaultModel;
      budgets[modelId] = Number(b.budget) || 0;
      await writeFile(BUDGET_FILE, JSON.stringify(budgets));
      return send(res, 200, { ok: true });
    }

    if (p.startsWith("/api/delete/") && req.method === "POST") {
      const id = decodeURIComponent(p.slice("/api/delete/".length));
      if (!/^g_[a-z0-9]+$/i.test(id)) return send(res, 400, { error: "bad id" });
      const files = (await readdir(STORAGE)).filter((f) => f === id || f.startsWith(id + "."));
      for (const f of files) await unlink(path.join(STORAGE, f)).catch(() => {});
      return send(res, 200, { ok: true, removed: files.length });
    }

    if (p.startsWith("/api/entry/")) {
      const id = decodeURIComponent(p.slice("/api/entry/".length));
      let meta; try { meta = await loadMeta(id); } catch { return send(res, 404, { error: "not found" }); }
      const refsData = { images: [], videos: [], audios: [] };
      for (const kind of ["images", "videos", "audios"])
        for (const f of meta.refs?.[kind] || []) {
          if (/^https?:\/\//i.test(f)) { refsData[kind].push(f); continue; }
          try { refsData[kind].push(await fileToDataUrl(f)); } catch {}
        }
      return send(res, 200, { model: meta.model || config.defaultModel, prompt: meta.prompt, params: meta.params, refs: refsData });
    }

    if (p.startsWith("/api/media/")) {
      const file = path.basename(decodeURIComponent(p.slice("/api/media/".length)));
      const full = path.join(STORAGE, file);
      if (!full.startsWith(STORAGE)) return send(res, 403, { error: "forbidden" });
      try {
        const data = await readFile(full);
        return send(res, 200, data, MIME[path.extname(full)] || "application/octet-stream");
      } catch { return send(res, 404, { error: "not found" }); }
    }

    // статика
    let file = p === "/" ? "/index.html" : p;
    const full = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
    if (!full.startsWith(path.join(__dirname, "public"))) return send(res, 403, { error: "forbidden" });
    try {
      const data = await readFile(full);
      return send(res, 200, data, MIME[path.extname(full)] || "application/octet-stream");
    } catch { return send(res, 404, { error: "not found" }); }
  } catch (e) {
    console.error(e);
    return send(res, 500, { error: e.message, body: e.body });
  }
});

server.listen(PORT, () => {
  console.log(`\n  Video Generator → http://localhost:${PORT}`);
  console.log(`  models: ${MODELS.map((m) => m.label + (keyPresent(m.id) ? "" : " (нет ключа)")).join(" · ")}`);
  console.log(`  storage: ${STORAGE}\n`);
});
