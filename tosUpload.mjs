// Заливка реф-файлов в BytePlus TOS + presigned GET URL (чтобы Ark мог их забрать).
// Креды читаются из .env: TOS_ACCESS_KEY, TOS_SECRET_KEY, TOS_REGION, TOS_ENDPOINT, TOS_BUCKET.
import { TosClient } from "@volcengine/tos-sdk";

let _client = null;

export function tosConfigured() {
  const e = process.env;
  return !!(e.TOS_ACCESS_KEY && e.TOS_SECRET_KEY && e.TOS_REGION && e.TOS_ENDPOINT && e.TOS_BUCKET);
}

function client() {
  if (!_client) {
    _client = new TosClient({
      accessKeyId: process.env.TOS_ACCESS_KEY,
      accessKeySecret: process.env.TOS_SECRET_KEY,
      region: process.env.TOS_REGION,
      endpoint: process.env.TOS_ENDPOINT,
    });
  }
  return _client;
}

// Загружает буфер и возвращает presigned GET URL (живёт TOS_PRESIGN_EXPIRES секунд, дефолт 2ч).
export async function uploadAndPresign(buffer, key, contentType) {
  const c = client();
  const bucket = process.env.TOS_BUCKET;
  await c.putObject({ bucket, key, body: buffer, contentType });
  return c.getPreSignedUrl({ bucket, key, method: "GET", expires: Number(process.env.TOS_PRESIGN_EXPIRES || 7200) });
}
