# Seedance Generator

Локальный веб-генератор видео на **Seedance 2.0** (BytePlus ModelArk; есть адаптер под fal.ai).
Без зависимостей — только Node 18+. API-ключ хранится на сервере и в браузер не передаётся.

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
   - `.env` → `SEEDANCE_API_KEY=<ключ>` и `MOCK=0`
   - `config.json` → `providers.byteplus.baseUrl`, `createPath`, `statusPath`, `models.*`
5. Перезапусти `node server.mjs`.

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

## Структура

| Файл | Назначение |
|---|---|
| `server.mjs` | HTTP-сервер: отдаёт UI, проксирует `/api/generate` и `/api/job/:id`, держит ключ |
| `seedanceClient.mjs` | Адаптеры провайдеров (byteplus / fal / mock), нормализация запроса/ответа |
| `config.json` | Провайдеры, endpoint-ы, model-id, дефолты и опции UI |
| `public/` | Интерфейс (одна страница) |
| `.env` | Ключ, порт, MOCK |

## Будущее (Seedance 2.5)

Когда выйдет 2.5 — поменять только `config.json → providers.byteplus.models.*` на новые id.
Код менять не нужно.
