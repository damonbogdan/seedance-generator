#!/usr/bin/env node
// Проверка актуальности моделей: живые OpenAPI-схемы fal + каталог fal + список моделей Google.
// Сверяет config.json с тем, что реально отдаёт API: диапазоны длительности, разрешения,
// форматы кадра, наличие полей (звук/негатив/сид/картинки), депрекации и вышедшие новые версии.
// CLI: npm run check-models. Из сервера: import { checkModels } → GET /api/check-updates.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const TIMEOUT = 20000;
async function jget(url, headers = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { "user-agent": "damon-videogen-check", ...headers }, signal: ctl.signal });
    if (!r.ok) return { status: r.status };
    return { status: r.status, body: await r.json() };
  } catch (e) {
    return { status: 0, error: String(e.message || e) };
  } finally { clearTimeout(t); }
}

// ── версии из id эндпоинта ──────────────────────────────────
// "fal-ai/kling-video/v3/pro/..." → 3 · "fal-ai/veo3.1/fast" → 3.1 · "bytedance/seedance-2.0/..." → 2.0
// Сегменты без чистой версии ("wan-25-preview", "wan-vace-14b") не парсим — лучше пропуск, чем враньё.
function versionOf(id) {
  for (const seg of String(id).split("/")) {
    let m = seg.match(/^v(\d+(?:\.\d+)?)/);      // v3, v2.7, v2.5-turbo
    if (m) return parseFloat(m[1]);
    m = seg.match(/^[a-z-]+?-?(\d+(?:\.\d+)?)$/); // veo3.1, sora-2, seedance-2.0, o3
    if (m) return parseFloat(m[1]);
  }
  return null;
}
// семейство и ключевое слово для поиска в каталоге: "fal-ai/kling-video/v3/..." → {fam:"kling-video", kw:"kling"}
function familyOf(endpoint) {
  const fam = String(endpoint).split("/")[1] || "";
  const base = fam.replace(/[-.]?v?\d.*$/, "") || fam; // veo3.1 → veo, sora-2 → sora, wan-25-preview → wan
  return { fam: base, kw: base.split("-")[0] };
}

// набор длительностей, который порождает конфиг (min..max с шагом)
function durSetFromUi(ui) {
  const out = [];
  for (let d = ui.durationMin; d <= ui.durationMax; d += ui.durationStep || 1) out.push(d);
  return out;
}

const eq = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// ── сверка одного эндпоинта со схемой ───────────────────────
function diffEndpoint(sub, kind, schema) {
  const issues = [];
  const props = schema?.properties || {};
  const f = sub.input || {}, ui = sub.ui || {};

  // длительность
  const dp = props.duration;
  if (dp) {
    const want = durSetFromUi(ui);
    if (dp.enum) {
      const nums = dp.enum.map(Number).filter(Number.isFinite);
      if (nums.length) {
        const bad = want.filter((d) => !nums.includes(d));
        const missing = nums.filter((d) => !want.includes(d));
        if (bad.length) issues.push(`длительность: конфиг шлёт ${bad.join(",")} c, а API принимает только ${Math.min(...nums)}–${Math.max(...nums)} (${kind})`);
        else if (missing.length) issues.push(`длительность: API умеет ещё ${missing.join(",")} c — в конфиге не выставляется (${kind})`);
      }
    } else if (dp.minimum != null || dp.maximum != null) {
      if (dp.minimum != null && ui.durationMin < dp.minimum) issues.push(`длительность: min в конфиге ${ui.durationMin}, у API ${dp.minimum} (${kind})`);
      if (dp.maximum != null && ui.durationMax > dp.maximum) issues.push(`длительность: max в конфиге ${ui.durationMax}, у API ${dp.maximum} (${kind})`);
      if (dp.minimum != null && ui.durationMin > dp.minimum) issues.push(`длительность: API разрешает от ${dp.minimum} c, конфиг начинает с ${ui.durationMin} (${kind})`);
      if (dp.maximum != null && ui.durationMax < dp.maximum) issues.push(`длительность: API разрешает до ${dp.maximum} c, конфиг заканчивает на ${ui.durationMax} (${kind})`);
    }
  }

  // разрешения (t2v сверяем строго, i2v — только чтобы конфиг не слал невалидное)
  if (f.resolution && props.resolution?.enum) {
    const api = props.resolution.enum.filter((r) => r !== "auto");
    const cfg = ui.resolutions || [];
    if (kind === "t2v" && !eq(api, cfg)) issues.push(`разрешения: в конфиге [${cfg}], у API [${api}]`);
    if (kind === "i2v") {
      const bad = cfg.filter((r) => !props.resolution.enum.includes(r));
      if (bad.length) issues.push(`разрешения: i2v не принимает [${bad}]`);
    }
  }

  // форматы кадра
  if (f.aspect && !(kind === "i2v" && f.aspectI2V === false)) {
    if (props.aspect_ratio?.enum) {
      const api = props.aspect_ratio.enum;
      const bad = (ui.aspectRatios || []).filter((a) => !api.includes(a));
      const extra = api.filter((a) => a !== "auto" && !(ui.aspectRatios || []).includes(a));
      if (bad.length) issues.push(`форматы: конфиг шлёт [${bad}], API их не принимает (${kind})`);
      else if (extra.length) issues.push(`форматы: у API есть ещё [${extra}] — в конфиге не выставляются (${kind})`);
    } else if (!props.aspect_ratio) issues.push(`aspect_ratio пропал из API (${kind}) — надо aspectI2V:false или aspect:false`);
  }
  if (kind === "i2v" && f.aspectI2V === false && props.aspect_ratio) issues.push("у i2v появился aspect_ratio — можно убрать aspectI2V:false");

  // поля
  const need = [
    [f.audioField, f.audioField, "звук"],
    [f.negativeField || f.negativeDefault, "negative_prompt", "негатив"],
    [f.cfgScale != null, "cfg_scale", "cfg"],
    [f.seedField, "seed", "seed"],
  ];
  if (kind === "i2v") {
    need.push([f.imageField, f.imageField, "картинка"]);
    need.push([f.endImageField, f.endImageField, "финальный кадр"]);
  }
  for (const [enabled, prop, label] of need) {
    if (enabled && prop && !(prop in props)) issues.push(`поле «${label}» (${prop}) пропало из API (${kind})`);
  }
  return issues;
}

// ── основная проверка ───────────────────────────────────────
export async function checkModels(config) {
  const fal = config.models.find((m) => m.provider === "fal");
  const report = { checkedAt: new Date().toISOString(), fal: [], omni: null, byteplus: null };

  // каталог по семействам — по одному запросу на семейство
  const kws = [...new Set((fal?.submodels || []).map((s) => familyOf(s.endpoint).kw))];
  const catalogs = {};
  await Promise.all(kws.map(async (kw) => {
    const r = await jget(`https://fal.ai/api/models?keywords=${encodeURIComponent(kw)}`);
    catalogs[kw] = r.body?.items || [];
  }));

  await Promise.all((fal?.submodels || []).map(async (sub) => {
    const entry = { id: sub.id, label: sub.label, endpoint: sub.endpoint, status: "ok", issues: [], newer: [], pricing: null };
    const eps = [["t2v", sub.endpoint], ...(sub.endpointI2V ? [["i2v", sub.endpointI2V]] : [])];

    for (const [kind, ep] of eps) {
      const r = await jget(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${encodeURIComponent(ep)}`);
      if (r.status !== 200 || !r.body?.components) {
        entry.status = "error";
        entry.issues.push(`эндпоинт ${ep} недоступен (HTTP ${r.status || r.error}) — переименован или удалён`);
        continue;
      }
      const schemas = r.body.components.schemas || {};
      const key = Object.keys(schemas).find((k) => /input/i.test(k));
      entry.issues.push(...diffEndpoint(sub, kind, schemas[key]));
    }

    // каталог: депрекация, цена, более новые версии
    const { fam, kw } = familyOf(sub.endpoint);
    const items = catalogs[kw] || [];
    const self = items.find((i) => i.id === sub.endpoint);
    if (self) {
      if (self.deprecated) { entry.status = "outdated"; entry.issues.push("fal пометил модель как deprecated"); }
      if (self.removed) { entry.status = "error"; entry.issues.push("fal пометил модель как removed"); }
      entry.pricing = self.pricingInfoOverride || null;
    }
    const myVer = versionOf(sub.endpoint) ?? versionOf(sub.endpointI2V || "");
    if (myVer != null) {
      const seen = new Set();
      for (const it of items) {
        if (!/(text|image)-to-video/.test(it.category || "")) continue;
        if (!it.id.includes(fam)) continue;
        const v = versionOf(it.id);
        if (v != null && v > myVer && !seen.has(it.id)) { seen.add(it.id); entry.newer.push(`${it.id} (v${v})`); }
      }
      if (entry.newer.length && entry.status === "ok") entry.status = "update";
    }
    if (entry.issues.length && entry.status === "ok") entry.status = "warn";
    report.fal.push(entry);
  }));
  // стабильный порядок — как в конфиге
  report.fal.sort((a, b) => fal.submodels.findIndex((s) => s.id === a.id) - fal.submodels.findIndex((s) => s.id === b.id));

  // Google Omni: жива ли модель, и не появилось ли новых видео-моделей
  const omni = config.models.find((m) => m.provider === "google");
  if (omni) {
    const key = process.env[omni.apiKeyEnv];
    if (!key) report.omni = { status: "skip", note: "нет ключа GOOGLE_API_KEY — проверка пропущена" };
    else {
      const r = await jget(`${omni.connection.baseUrl}/models?pageSize=1000`, { "x-goog-api-key": key });
      if (r.status !== 200) report.omni = { status: "error", note: `Google API: HTTP ${r.status || r.error}` };
      else {
        const names = (r.body.models || []).map((m) => m.name.replace("models/", ""));
        const exists = names.includes(omni.connection.model);
        const candidates = names.filter((n) => /omni|veo/i.test(n) && n !== omni.connection.model);
        report.omni = {
          status: exists ? "ok" : "error",
          model: omni.connection.model,
          note: exists ? "модель на месте" : "модель ПРОПАЛА из Google API — смени connection.model",
          candidates,
        };
      }
    }
  }

  // BytePlus: публичного каталога нет — только ручная проверка в консоли
  const bp = config.models.find((m) => m.provider === "byteplus");
  if (bp) report.byteplus = {
    status: "manual",
    models: Object.values(bp.connection.models || {}),
    note: "BytePlus ModelArk не отдаёт публичный каталог — сверяй версии в консоли",
    url: "https://console.byteplus.com/ark",
  };

  return report;
}

// ── CLI ─────────────────────────────────────────────────────
const ICON = { ok: "✅", warn: "⚠️", update: "🆕", outdated: "⛔", error: "⛔", skip: "➖", manual: "✋" };
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  // ключи из .env (для проверки Google) — без зависимостей
  try {
    for (const line of readFileSync(path.join(ROOT, ".env"), "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
  const config = JSON.parse(readFileSync(path.join(ROOT, "config.json"), "utf8"));
  const rep = await checkModels(config);
  console.log(`Проверка моделей · ${rep.checkedAt}\n`);
  for (const e of rep.fal) {
    console.log(`${ICON[e.status]} ${e.label}  (${e.endpoint})`);
    for (const i of e.issues) console.log(`     · ${i}`);
    for (const n of e.newer) console.log(`     🆕 новее: ${n}`);
  }
  if (rep.omni) {
    console.log(`${ICON[rep.omni.status]} Google Omni — ${rep.omni.note}`);
    for (const c of rep.omni.candidates || []) console.log(`     · доступна также: ${c}`);
  }
  if (rep.byteplus) console.log(`${ICON.manual} Seedance (BytePlus): ${rep.byteplus.models.join(", ")} — ${rep.byteplus.note}`);
  const problems = rep.fal.filter((e) => e.status !== "ok").length;
  console.log(`\nИтог: ${rep.fal.length - problems}/${rep.fal.length} fal-моделей без замечаний.`);
}
