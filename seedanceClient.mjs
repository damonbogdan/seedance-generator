// Seedance API client (BytePlus Ark).
// Нормализованные параметры:
//   { prompt, mode, resolution, duration, aspectRatio, audio, watermark, returnLastFrame, seed,
//     images:[url|dataUrl], videos:[...], audios:[...] }
// submit() -> { providerId };  status(id) -> { state, videoUrl, tokens, error, raw }

async function httpJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { _raw: text }; }
  if (!res.ok) {
    const msg = body?.error?.message || body?.message || body?._raw || `HTTP ${res.status}`;
    const err = new Error(`Провайдер вернул ${res.status}: ${msg}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

function byteplusClient({ apiKey, pcfg }) {
  const headers = { Authorization: `${pcfg.authScheme} ${apiKey}`, "Content-Type": "application/json" };

  // Ark: content-массив (text + *_url с role), параметры на верхнем уровне.
  function buildBody(p) {
    const content = [{ type: "text", text: p.prompt }];
    for (const url of p.images || []) content.push({ type: "image_url", image_url: { url }, role: "reference_image" });
    for (const url of p.videos || []) content.push({ type: "video_url", video_url: { url }, role: "reference_video" });
    for (const url of p.audios || []) content.push({ type: "audio_url", audio_url: { url }, role: "reference_audio" });
    const body = {
      model: pcfg.models[p.mode] || pcfg.models.pro,
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
      const body = await httpJson(pcfg.baseUrl + pcfg.createPath, {
        method: "POST", headers, body: JSON.stringify(buildBody(params)),
      });
      const providerId = body.id || body.task_id || body.job_id || body.data?.id;
      if (!providerId) { const e = new Error("В ответе нет task id."); e.body = body; throw e; }
      return { providerId };
    },
    async status(id) {
      const url = pcfg.baseUrl + pcfg.statusPath.replace("{id}", encodeURIComponent(id));
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

export function buildClient({ apiKey, config }) {
  const name = config.provider;
  const pcfg = config.providers[name];
  if (!pcfg) throw new Error(`Неизвестный provider: ${name}`);
  if (name === "byteplus") return byteplusClient({ apiKey, pcfg });
  throw new Error(`Нет адаптера для provider=${name}`);
}
