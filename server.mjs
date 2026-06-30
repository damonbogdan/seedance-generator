// Локальный сервер Seedance Generator.
// Ключ живёт только здесь. Готовые видео и рефы скачиваются в локальное хранилище
// (по аналогии с DamonIGS), хранится история и метаданные для повтора генераций.
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
const API_KEY = process.env.SEEDANCE_API_KEY || "";
if (!API_KEY) { console.error("Нет SEEDANCE_API_KEY в .env"); process.exit(1); }

const STORAGE = config.storageDir.replace(/^~/, os.homedir());
await mkdir(STORAGE, { recursive: true });

const client = buildClient({ apiKey: API_KEY, config });
const pcfg = config.providers[config.provider];

const BUDGET_FILE = path.join(STORAGE, "budget.json");
async function getBudget() { try { return JSON.parse(await readFile(BUDGET_FILE, "utf8")).budget; } catch { return null; } }

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
function unitPerK(mode, resolution, hasVideoInput) {
  const m = config.pricing.unitPerK[mode] || config.pricing.unitPerK.pro;
  const r = m[resolution] || m["720p"] || Object.values(m)[0];
  return hasVideoInput ? r.v : r.nv;
}
function costOf(tokens, mode, resolution, hasVideoInput) {
  return +(tokens / 1000 * unitPerK(mode, resolution, hasVideoInput)).toFixed(4);
}
async function fileToDataUrl(file) {
  const buf = await readFile(path.join(STORAGE, file));
  const mime = MIME[path.extname(file)] || "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// Видео/аудио для отправки в Ark: data:base64 нельзя — заливаем в TOS и берём presigned URL.
// http(s)-URL оставляем как есть. Картинки можно слать base64, их не трогаем.
async function refsForSubmit(id, kind, list) {
  const out = [];
  let i = 1;
  for (const item of list || []) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) { out.push(item); i++; continue; }
    const d = dataUrlToBuffer(item);
    if (!d) continue;
    const filename = `${id}.${kind}${i}.${d.ext}`;
    // TOS (если настроен) — лучший путь; иначе временный публичный хостинг
    const url = tosConfigured()
      ? await uploadAndPresign(d.buf, `seedance-refs/${filename}`, d.mime)
      : await uploadTemp(d.buf, filename, d.mime);
    out.push(url);
    i++;
  }
  return out;
}

// сохранить рефы на диск, вернуть {images:[file],videos:[file],audios:[file]}
async function persistRefs(id, kind, list) {
  const out = [];
  let i = 1;
  for (const item of list || []) {
    if (typeof item === "string" && /^https?:\/\//i.test(item)) { out.push(item); continue; } // реф по URL — храним как есть
    const d = dataUrlToBuffer(item);
    if (!d) continue;
    const file = `${id}.${kind}${i}.${d.ext}`;
    await writeFile(path.join(STORAGE, file), d.buf);
    out.push(file); i++;
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === "/api/config") {
      return send(res, 200, {
        provider: config.provider,
        providerLabel: pcfg.label,
        defaults: config.defaults,
        ui: config.ui,
        pricing: config.pricing,
        fps: config.fps,
        purchaseUrl: config.purchaseUrl,
        storageDir: STORAGE,
        tosEnabled: tosConfigured(),
      });
    }

    if (p === "/api/generate" && req.method === "POST") {
      const b = await readJsonBody(req);
      if (!b.prompt || !String(b.prompt).trim()) return send(res, 400, { error: "Пустой промпт" });
      const id = "g_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const refs = {
        images: await persistRefs(id, "img", b.images),
        videos: await persistRefs(id, "vid", b.videos),
        audios: await persistRefs(id, "aud", b.audios),
      };
      const hasVideoInput = (b.videos || []).length > 0;
      const params = {
        mode: b.mode || "pro", resolution: b.resolution, duration: Number(b.duration),
        aspectRatio: b.aspectRatio, audio: !!b.audio, watermark: !!b.watermark,
        returnLastFrame: !!b.returnLastFrame, seed: b.seed || null, hasVideoInput,
      };
      // картинки можно base64; видео/аудио — через TOS presigned URL
      const submitVideos = await refsForSubmit(id, "vid", b.videos);
      const submitAudios = await refsForSubmit(id, "aud", b.audios);
      const { providerId } = await client.submit({ prompt: b.prompt, ...params, images: b.images, videos: submitVideos, audios: submitAudios });
      const meta = { id, createdAt: Date.now(), status: "pending", prompt: b.prompt, params, refs, providerId, tokens: null, cost: null };
      await saveMeta(meta);
      return send(res, 200, { jobId: id });
    }

    if (p.startsWith("/api/job/")) {
      const id = decodeURIComponent(p.slice("/api/job/".length));
      let meta;
      try { meta = await loadMeta(id); } catch { return send(res, 404, { error: "Неизвестная задача" }); }
      if (meta.status === "done")
        return send(res, 200, { state: "completed", videoUrl: `/api/media/${id}.mp4`, tokens: meta.tokens, cost: meta.cost });
      const st = await client.status(meta.providerId);
      if (st.state === "completed") {
        // скачать видео в локальное хранилище (ссылка живёт ~24ч)
        let videoUrl = st.videoUrl;
        try {
          const r = await fetch(st.videoUrl);
          const buf = Buffer.from(await r.arrayBuffer());
          await writeFile(path.join(STORAGE, id + ".mp4"), buf);
          videoUrl = `/api/media/${id}.mp4`;
        } catch (e) { console.error("download failed", e.message); }
        meta.status = "done"; meta.tokens = st.tokens || null;
        meta.cost = st.tokens ? costOf(st.tokens, meta.params.mode, meta.params.resolution, meta.params.hasVideoInput) : null;
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
      const totalSpent = +metas.reduce((s, m) => s + (m.cost || 0), 0).toFixed(4);
      const budget = await getBudget();
      const list = metas.map((m) => ({
        id: m.id, createdAt: m.createdAt, status: m.status, prompt: m.prompt, params: m.params,
        tokens: m.tokens, cost: m.cost, error: m.error || null,
        hasVideo: existsSync(path.join(STORAGE, m.id + ".mp4")),
        refCounts: { images: m.refs?.images?.length || 0, videos: m.refs?.videos?.length || 0, audios: m.refs?.audios?.length || 0 },
      }));
      return send(res, 200, {
        totalSpent, count: list.length, items: list,
        budget, remaining: budget != null ? +(budget - totalSpent).toFixed(2) : null,
      });
    }

    if (p === "/api/budget" && req.method === "POST") {
      const b = await readJsonBody(req);
      await writeFile(BUDGET_FILE, JSON.stringify({ budget: Number(b.budget) || 0 }));
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
      return send(res, 200, { prompt: meta.prompt, params: meta.params, refs: refsData });
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
  console.log(`\n  Seedance Generator → http://localhost:${PORT}`);
  console.log(`  storage: ${STORAGE}\n`);
});
