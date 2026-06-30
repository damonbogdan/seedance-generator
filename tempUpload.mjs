// Авто-заливка реф-файла на временный публичный хостинг → публичный URL для Ark.
// Без ключей и без настройки. Файл авто-удаляется (~1ч). Используется, когда TOS не настроен.
// Приоритет: tmpfiles.org (авто-удаление 1ч) → 0x0.st (expires 1ч) как фолбэк.

async function viaTmpfiles(buffer, filename, contentType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType || "application/octet-stream" }), filename);
  const r = await fetch("https://tmpfiles.org/api/v1/upload", { method: "POST", body: form });
  if (!r.ok) throw new Error(`tmpfiles ${r.status}`);
  const j = await r.json();
  const u = j?.data?.url;
  if (!u) throw new Error("tmpfiles: нет url в ответе");
  // прямая ссылка на файл: tmpfiles.org/123/name → tmpfiles.org/dl/123/name, форсим https
  return u.replace(/^http:/, "https:").replace("tmpfiles.org/", "tmpfiles.org/dl/");
}

async function via0x0(buffer, filename, contentType) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: contentType || "application/octet-stream" }), filename);
  form.append("expires", "1"); // часов
  const r = await fetch("https://0x0.st", { method: "POST", body: form, headers: { "User-Agent": "seedance-generator/1.0" } });
  if (!r.ok) throw new Error(`0x0 ${r.status}`);
  const url = (await r.text()).trim();
  if (!/^https?:\/\//i.test(url)) throw new Error("0x0: неожиданный ответ");
  return url;
}

export async function uploadTemp(buffer, filename, contentType) {
  try { return await viaTmpfiles(buffer, filename, contentType); }
  catch (e1) {
    try { return await via0x0(buffer, filename, contentType); }
    catch (e2) { throw new Error(`Не удалось залить реф на временный хостинг (${e1.message}; ${e2.message})`); }
  }
}
