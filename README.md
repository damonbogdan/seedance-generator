# Seedance Generator

Локальный веб-генератор видео с несколькими движками в виде **больших вкладок**:
- **Seedance 2.0** (BytePlus ModelArk) — токенная тарификация, рефы картинки/видео/аудио.
- **Google Omni** (Gemini Omni Flash, `gemini-omni-flash-preview`) — прямой Gemini API, до 10 c, 16:9/9:16, нативный звук, рефы-картинки.
- **fal.ai** (агрегатор, pay-as-you-go) — одна вкладка, внутри выпадашка из ~10 актуальных моделей: **Kling V3 Pro/Standard, Seedance 2.0 (+Fast), Google Veo 3.1 (+Fast), Sora 2 Pro, PixVerse v4.5, Grok Imagine (xAI), Wan 2.5**. Оплата картой по факту.

У каждой модели свой экран настроек и свои цены, но **лента готовых видео — общая** (карточки помечены ярлыком модели/подмодели).
Ключи хранятся на сервере и в браузер не передаются; менять их можно прямо в UI (⚙ Настройки → 🔑 Ключи API, без перезапуска). Node 18+.

## Запуск

```bash
cd seedance-generator
cp .env.example .env      # уже создан с MOCK=1
node server.mjs
# открыть http://localhost:5178
```

Без ключа стартует в **MOCK-режиме**: интерфейс полностью рабочий, вместо реального рендера
отдаётся демо-видео. Удобно проверять UI, не тратя кредиты.

## Подключить реальный API

1. Зарегистрируйся на **BytePlus ModelArk**: https://www.byteplus.com/en/product/modelark
2. Создай API-ключ (Console → API keys).
3. В `console` найди карточку модели Seedance 2.0, **скопируй точные `model-id`** и базовый
   endpoint (у Ark API он вида `https://ark.*.bytepluses.com/api/v3/...` и может отличаться от
   шаблона в `config.json`).
4. Впиши значения:
   - `.env` → `SEEDANCE_API_KEY=<ключ>`
   - `config.json` → блок модели `seedance` → `connection.baseUrl`, `createPath`, `statusPath`, `models.*`
5. Перезапусти `node server.mjs`.

## Подключить Google Omni

1. Возьми ключ Google AI Studio (Gemini API): https://aistudio.google.com/apikey
2. `.env` → `GOOGLE_API_KEY=<ключ>`, перезапусти `node server.mjs`.
3. Вкладка **Google Omni** активируется сама (индикатор «● ключ» на вкладке).

Боевой формат Omni зашит в `config.json` → модель `omni` → `connection`:
- base `https://generativelanguage.googleapis.com/v1beta`, create `POST /interactions`, ключ в заголовке `x-goog-api-key`
- модель `gemini-omni-flash-preview`, результат — файл, докачивается по `files/{id}:download`

Схема тела **выверена вживую** по реальному API:
```json
{
  "model": "gemini-omni-flash-preview",
  "input": [ {"type":"text","text":"…"}, {"type":"image","data":"<base64>","mime_type":"image/png"} ],
  "response_format": { "type":"video", "aspect_ratio":"16:9|9:16", "duration":"8s", "delivery":"uri" },
  "generation_config": { "seed": 42, "video_config": { "task":"text_to_video" } }
}
```
- `aspect_ratio` — только `16:9` / `9:16`; `duration` — **строка вида `"8s"`**; `seed` — в `generation_config`, `task` — в `video_config`.
- `task`: `text_to_video` / `image_to_video` / `reference_to_video` / `edit` / `extend` (у нас — авто по числу картинок).
- **`resolution` в API не выбирается** — его задаёт сама модель.

> ⚠️ **Квота.** Даже с валидным ключом генерация Omni вернёт `429 "You do not have enough quota"`, пока на
> проекте Google не включён биллинг / не выдана квота на `gemini-omni-flash-preview` (это preview-модель).
> Проверить ключ можно бесплатно: `GET /v1beta/models` (200 = ключ ок). Схема запроса/ответа новая (анонс
> 30.06.2026) — если поменяется, правь `connection` в `config.json` или адаптер `googleClient`, сервер не трогать.

Боевой формат уже зашит:
- base `https://ark.ap-southeast.bytepluses.com/api/v3`
- create `POST /contents/generations/tasks`, status `GET /contents/generations/tasks/{id}`
- model-id `dreamina-seedance-2-0-260128` / `...-fast-260128` (сверь в Model list — суффикс-дата может меняться)
- тело через `content`-массив, `generate_audio`, статус `succeeded`, видео в `content.video_url` (живёт ~24ч — скачивай сразу)

Если что-то не сойдётся — правь только адаптер `byteplusClient` в `seedanceClient.mjs`.

> ⚠️ **Геоблок.** Консоль ModelArk блокирует US-регион (нужен VPN, напр. Таиланд). Открытый вопрос —
> проверяет ли регион сам API при вызове. Если да, генератор с домашнего US-IP не сработает даже с ключом.
> Два решения: (а) держать VPN включённым на машине с сервером, или **(б) лучше — задеплоить `server.mjs`
> на VPS в разрешённом регионе (Сингапур)**. Ключ и так живёт только на сервере, так что хостинг в SG
> = локальный VPN не нужен. Сначала просто проверь: `curl` к API без VPN из США — если 403/region, нужен (б).

## Переключить на fal.ai

В `config.json` поставь `"provider": "fal"`, в `.env` положи fal-ключ. Адаптер `falClient`
использует queue-API и заголовок `Authorization: Key <...>` — пути сверь на странице модели на fal.ai.

## Подключить fal.ai (агрегатор)

1. Ключ на https://fal.ai/dashboard/keys (формат `key_id:secret`), пополни баланс: https://fal.ai/dashboard/billing
2. `.env` → `FAL_API_KEY=<key_id:secret>` (или впиши в UI: ⚙ Настройки → 🔑 Ключи API).
3. Вкладка **fal.ai** → выпадашка «Модель fal» (~10 актуальных, июль 2026): Kling V3 Pro/Standard, Seedance 2.0 (+Fast),
   Veo 3.1 (+Fast), Sora 2 Pro, PixVerse v4.5, Grok Imagine (xAI), Wan 2.5.

Как устроено (`config.json` → модель `fal` → `submodels[]`):
- Одна вкладка, много подмоделей. У каждой свой `endpoint` (+ `endpointI2V` для image-to-video), `input` (маппинг полей:
  формат длительности, поле картинки, поле звука, negative/cfg, seed), `ui` (длительность/форматы/рефы/опции) и `pricing` (оценка $/сек).
- Очередь fal: `POST https://queue.fal.run/{endpoint}` (заголовок `Authorization: Key …`) → `response_url` → поллинг
  `…/status` → результат, видео в `video.url`. Схемы всех 10 моделей выверены по докам fal (эндпоинты, поля, длительности, цены).
- Нюансы схем, которые уже учтены: у Kling V3 картинка идёт в `start_image_url` (не `image_url`); Seedance 2.0 и Grok — **без**
  префикса `fal-ai/` в эндпоинте (`bytedance/…`, `xai/…`); Veo 3.1 хочет длительность строкой `"8s"`; Seedance 2.0 и Sora 2 —
  звук нативный (тумблера нет). Цены помечены как оценка — списывает fal по факту.
- Добавить ещё модель fal = просто ещё один объект в `submodels` (endpoint + input + ui + pricing), код не трогая.
  Каталог fal большой и быстро меняется — тут собран выверенный топ, а не всё подряд.

> ⚠️ **Баланс.** Ключ проходит авторизацию, но генерация вернёт `403 "Exhausted balance"`, пока не пополнишь баланс fal.
> Разные подмодели тарифицируются по-разному (Wan ~$0.05/с … Veo 3 ~$0.40/с) — цифры в UI это оценка, списывает fal по факту.

## Учёт расходов и докупка кредитов

У каждого движка (вкладки) — свой **экран «Счёт»** прямо над настройками:
- **Пополнено** — вписываешь, сколько занёс на счёт этого движка (хранится per-model в `~/seedance/db/budget.json`).
- **Потрачено / Остаток / Генераций (+ средняя цена)** — считаются по факту: Seedance — по токенам из ответа API, Omni/fal — по секундам (оценка).
- **Прогресс-бар** внесённого + предупреждение, когда кредиты на исходе или баланс превышен.
- **Кнопка «Пополнить кредиты»** ведёт на биллинг именно этого провайдера (`purchaseUrl` в `config.json`).
- Строка **«Все движки»** — сводка расходов/остатков по всем вкладкам сразу (клик по движку переключает вкладку).

Тарифы у провайдеров разные (`pricingModel`: `tokens` у Seedance, `perSecond` у Omni и подмоделей fal) — цифры в UI это оценка,
списывает деньги сам провайдер по факту. Ссылки на пополнение и на выпуск ключей продублированы в ⚙ Настройки → 🔑 Ключи API.

## Структура

| Файл | Назначение |
|---|---|
| `server.mjs` | HTTP-сервер: мультимодельная маршрутизация `/api/generate` и `/api/job/:id`, общий стор, держит ключи |
| `seedanceClient.mjs` | Адаптеры провайдеров (`byteplus` / `google` / `fal`), нормализация запроса/ответа |
| `config.json` | Модели-вкладки (у `fal` — `submodels[]`): endpoint-ы, model-id, дефолты, цены и опции UI каждой |
| `public/` | Интерфейс (вкладки движков + общая лента) |
| `.env` | Ключи (`SEEDANCE_API_KEY`, `GOOGLE_API_KEY`), порт |

## Будущее (Seedance 2.5)

Когда выйдет 2.5 — поменять только `config.json → providers.byteplus.models.*` на новые id.
Код менять не нужно.
