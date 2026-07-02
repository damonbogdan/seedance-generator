// Клиенты видеомоделей. Один адаптер на провайдера, единый нормализованный интерфейс:
//   submit(params) -> { providerId, ready? }   // ready = {videoUrl, tokens} если видео уже готово (синхронный API)
//   status(id)     -> { state, videoUrl, tokens, error, raw }
// params: { prompt, mode, resolution, duration, aspectRatio, audio, watermark, returnLastFrame,
//           task, seed, images:[url|dataUrl], videos:[...], audios:[...] }

async function httpJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { _raw: text }; }
  if (!res.ok) {
    const detail = typeof body?.detail === "string" ? body.detail : (body?.detail ? JSON.stringify(body.detail) : null);
    const msg = body?.error?.message || body?.message || detail || body?._raw || `HTTP ${res.status}`;
    const err = new Error(`Провайдер вернул ${res.status}: ${msg}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

// ── BytePlus Ark (Seedance 2.0) ────────────────────────────────────────────────
function byteplusClient({ apiKey, conn }) {
  const headers = { Authorization: `${conn.authScheme} ${apiKey}`, "Content-Type": "application/json" };

  function buildBody(p) {
    const content = [{ type: "text", text: p.prompt }];
    for (const url of p.images || []) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    for (const url of p.videos || []) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    for (const url of p.audios || []) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    const body = {
      model: conn.models[p.mode] || conn.models.pro,
      content,
      ratio: p.aspectRatio,
      resolution: p.resolution,
      duration: Number(p.duration),
      generate_audio: !!p.audio,
      watermark: !!p.watermark,
    };
    if (p.returnLastFrame) body.return_last_frame = true;
    if (p.seed !== undefined && p.seed !== null && p.seed !== "") body.seed = Number(p.seed);
    return body;
  }

  return {
    async submit(params) {
      const body = await httpJson(conn.baseUrl + conn.createPath, {
        method: "POST", headers, body: JSON.stringify(buildBody(params)),
      });
      const providerId = body.id || body.task_id || body.job_id || body.data?.id;
      if (!providerId) { const e = new Error("В ответе нет task id."); e.body = body; throw e; }
      return { providerId };
    },
    async status(id) {
      const url = conn.baseUrl + conn.statusPath.replace("{id}", encodeURIComponent(id));
      const raw = await httpJson(url, { headers });
      const s = String(raw.status || raw.state || "").toLowerCase();
      const videoUrl = raw.content?.video_url || raw.video_url || raw.output?.video_url;
      const tokens = raw.usage?.total_tokens ?? raw.usage?.completion_tokens ?? null;
      if (["succeeded", "completed", "success", "done"].includes(s) || videoUrl)
        return { state: "completed", videoUrl, tokens, raw };
      if (["failed", "error", "canceled", "cancelled"].includes(s))
        return { state: "failed", error: raw.error?.message || raw.error || raw.message || s, raw };
      return { state: "pending", raw };
    },
  };
}

// ── Google Gemini Omni Flash (direct API) ──────────────────────────────────────
// Interactions API: один POST возвращает шаги (steps) с готовым видео (uri или base64).
// Файл докачивается по files/{id}:download. Модель нативно делает звук; рефы — только картинки.
function dataUrlParts(s) {
  const m = String(s).match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { mime: m[1], data: m[2] } : null;
}
async function toInlineImage(ref) {
  const d = dataUrlParts(ref);
  if (d) return { type: "image", mime_type: d.mime, data: d.data };
  // публичный URL: скачиваем и инлайним как base64 (Interactions ждёт data или files/uri)
  const r = await fetch(ref);
  if (!r.ok) throw new Error(`Не удалось скачать картинку-реф: ${r.status}`);
  const mime = r.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await r.arrayBuffer());
  return { type: "image", mime_type: mime, data: buf.toString("base64") };
}
function resolveTask(task, imgCount) {
  if (task && task !== "auto") return task;
  if (imgCount === 0) return "text_to_video";
  if (imgCount === 1) return "image_to_video";
  return "reference_to_video";
}
function pickVideo(resp) {
  // ищем в steps последний контент type=video
  const steps = resp.steps || resp.output?.steps || [];
  for (let i = steps.length - 1; i >= 0; i--) {
    for (const c of steps[i].content || []) {
      if (c.type === "video" || c.mime_type?.startsWith?.("video/")) return c;
    }
  }
  // фолбэки на плоские поля
  if (resp.video) return resp.video;
  return null;
}
function fileIdFromUri(uri) {
  const m = String(uri).match(/files\/([^:?/]+)/);
  return m ? m[1] : null;
}

function googleClient({ apiKey, conn }) {
  const headers = { [conn.authHeader]: apiKey, "Content-Type": "application/json" };
  const downloadUrl = (fileId) =>
    conn.baseUrl + conn.downloadPath.replace("{id}", encodeURIComponent(fileId)) +
    (conn.downloadPath.includes("?") ? "&" : "?") + "key=" + encodeURIComponent(apiKey);

  // Схема выверена вживую по /interactions:
  //   response_format: { type:"video", aspect_ratio:"16:9"|"9:16", duration:"8s"(строка!), delivery:"uri" }
  //   generation_config: { seed?, video_config:{ task } }
  //   resolution в API НЕ настраивается; длительность — строкой "<N>s".
  async function buildBody(p) {
    const input = [{ type: "text", text: p.prompt }];
    for (const ref of p.images || []) input.push(await toInlineImage(ref));
    const task = resolveTask(p.task, (p.images || []).length);
    const body = {
      model: conn.model,
      input,
      response_format: {
        type: "video",
        aspect_ratio: p.aspectRatio,
        duration: `${Math.round(Number(p.duration) || 8)}s`,
        delivery: conn.delivery || "uri",
      },
      generation_config: { video_config: { task } },
    };
    if (p.seed !== undefined && p.seed !== null && p.seed !== "") body.generation_config.seed = Number(p.seed);
    return body;
  }

  return {
    async submit(params) {
      const resp = await httpJson(conn.baseUrl + conn.createPath, {
        method: "POST", headers, body: JSON.stringify(await buildBody(params)),
      });
      const v = pickVideo(resp);
      const tokens = resp.usage?.total_tokens ?? resp.usage?.output_tokens ?? null;
      const fileId = v?.uri ? fileIdFromUri(v.uri) : null;
      let videoUrl = null;
      if (fileId) videoUrl = downloadUrl(fileId);
      else if (v?.data) videoUrl = `data:${v.mime_type || "video/mp4"};base64,${v.data}`;
      if (!videoUrl && !fileId) { const e = new Error("В ответе Omni нет видео (ни uri, ни data)."); e.body = resp; throw e; }
      // видео обычно готово сразу (синхронный вызов) — отдаём ready; иначе сервер добьёт через status()
      return { providerId: fileId || ("omni_" + (resp.id || Date.now())), ready: videoUrl ? { videoUrl, tokens } : null };
    },
    async status(id) {
      // фолбэк-поллинг: если файл ещё готовится
      if (!/^[A-Za-z0-9_-]+$/.test(id) || id.startsWith("omni_")) return { state: "pending" };
      const raw = await httpJson(conn.baseUrl + conn.filePath.replace("{id}", encodeURIComponent(id)), { headers });
      const st = String(raw.state || raw.status || "").toUpperCase();
      if (st === "ACTIVE" || raw.uri || raw.downloadUri) return { state: "completed", videoUrl: downloadUrl(id), tokens: null, raw };
      if (st === "FAILED" || st === "ERROR") return { state: "failed", error: raw.error?.message || raw.error || st, raw };
      return { state: "pending", raw };
    },
  };
}

// ── fal.ai (агрегатор: Kling / Veo / Seedance / Wan …) ─────────────────────────
// queue-API: POST /{endpoint} → {response_url,status_url}; poll status; забрать результат (video.url).
// Одна вкладка = много подмоделей (model.submodels), выбор приходит в params.submodel.
function firstImageRef(images) {
  const im = (images || [])[0];
  return im || null; // dataURL или http(s)-URL — fal принимает data-URI в image_url
}
function falClient({ apiKey, conn, model }) {
  const headers = { Authorization: `${conn.authScheme} ${apiKey}`, "Content-Type": "application/json" };
  const subById = (id) => (model.submodels || []).find((s) => s.id === id) || (model.submodels || [])[0];

  function buildInput(sub, p, isI2V) {
    const inp = { prompt: p.prompt };
    const dur = Number(p.duration);
    const f = sub.input || {};
    if (f.durationFormat === "sec") inp.duration = `${dur}s`;
    else if (f.durationFormat === "number") inp.duration = dur;
    else inp.duration = String(dur); // "plain" → "5"
    // у части i2v-эндпоинтов (Kling, Grok, PixVerse, Wan) формат кадра задаёт картинка — aspect_ratio в схеме нет
    if (f.aspect && !(isI2V && f.aspectI2V === false)) inp.aspect_ratio = p.aspectRatio;
    if (f.resolution && p.resolution) inp.resolution = p.resolution;
    if (f.audioField) inp[f.audioField] = !!p.audio;
    // негатив: текст пользователя приоритетнее дефолта; пустая строка = пользователь явно убрал негатив
    if (p.negativePrompt != null && (f.negativeField || f.negativeDefault)) {
      const t = String(p.negativePrompt).trim();
      if (t) inp.negative_prompt = t;
      else if (f.negativeDefault) inp.negative_prompt = ""; // явно перебиваем дефолт модели пустым
    } else if (f.negativeDefault) inp.negative_prompt = f.negativeDefault;
    const cfg = (p.cfgScale != null && p.cfgScale !== "") ? Number(p.cfgScale) : f.cfgScale;
    if (cfg != null && isFinite(cfg)) inp.cfg_scale = cfg;
    if (f.seedField && p.seed !== undefined && p.seed !== null && p.seed !== "") inp.seed = Number(p.seed);
    const img = firstImageRef(p.images);
    if (f.imageField && img) inp[f.imageField] = img;
    const img2 = (p.images || [])[1];
    if (f.endImageField && img2) inp[f.endImageField] = img2; // Kling: 2-я картинка = финальный кадр
    return inp;
  }

  return {
    async submit(params) {
      const sub = subById(params.submodel);
      const img = firstImageRef(params.images);
      const isI2V = !!(sub.endpointI2V && img);
      const endpoint = isI2V ? sub.endpointI2V : sub.endpoint;
      const body = await httpJson(`${conn.baseUrl}/${endpoint}`, {
        method: "POST", headers, body: JSON.stringify(buildInput(sub, params, isI2V)),
      });
      const responseUrl = body.response_url || (body.request_id ? `${conn.baseUrl}/${endpoint}/requests/${body.request_id}` : null);
      if (!responseUrl) { const e = new Error("fal не вернул request_id/response_url."); e.body = body; throw e; }
      return { providerId: responseUrl };
    },
    async status(id) {
      const stRaw = await httpJson(id + "/status", { headers });
      const st = String(stRaw.status || "").toUpperCase();
      if (st === "COMPLETED" || st === "OK") {
        const out = await httpJson(id, { headers });
        const videoUrl = out.video?.url || out.output?.video?.url || out.video_url;
        if (videoUrl) return { state: "completed", videoUrl, tokens: null, raw: out };
        return { state: "failed", error: out.detail || out.error || "fal: в результате нет video.url", raw: out };
      }
      if (["FAILED", "ERROR", "CANCELED", "CANCELLED"].includes(st))
        return { state: "failed", error: stRaw.error || stRaw.detail || st, raw: stRaw };
      return { state: "pending", raw: stRaw };
    },
  };
}

const ADAPTERS = { byteplus: byteplusClient, google: googleClient, fal: falClient };

// buildClient({ apiKey, model }) — model это блок из config.models (со своим .connection)
export function buildClient({ apiKey, model }) {
  const make = ADAPTERS[model.provider];
  if (!make) throw new Error(`Нет адаптера для provider=${model.provider}`);
  return make({ apiKey, conn: model.connection, model });
}
