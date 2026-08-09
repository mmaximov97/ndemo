import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execa } from "execa";
import { skillDir } from "./tts.js";

const SCRIPT = path.join(skillDir(), "contrib", "ailab-tts.sh");

/** Минимальный корректный WAV: PCM 16 бит, mono 24 кГц, тишина. */
function silentWav(seconds = 0.4, rate = 24000): Buffer {
  const samples = Math.floor(seconds * rate);
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

interface Gateway {
  url: string;
  submits: number;
  close: () => Promise<void>;
}

/**
 * @param outcomes исход каждого последующего задания: "ok" | "failed"
 * @param output содержимое ответа на /output — по умолчанию валидный wav;
 *   тест на срыв конвертации подсовывает сюда произвольный не-wav буфер.
 */
async function fakeGateway(outcomes: Array<"ok" | "failed">, output: Buffer = silentWav()): Promise<Gateway> {
  let submits = 0;
  const polls = new Map<string, number>();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    if (req.method === "POST" && url === "/v1/audio/speech") {
      req.resume();
      const id = `job_${submits}`;
      submits += 1;
      polls.set(id, 0);
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status: "queued" }));
      return;
    }
    const outputMatch = url.match(/^\/v1\/jobs\/(job_\d+)\/output$/);
    if (outputMatch) {
      res.writeHead(200, { "content-type": "audio/wav" });
      res.end(output);
      return;
    }
    const jobMatch = url.match(/^\/v1\/jobs\/(job_\d+)$/);
    if (jobMatch) {
      const id = jobMatch[1];
      const seen = (polls.get(id) ?? 0) + 1;
      polls.set(id, seen);
      const index = Number(id.slice(4));
      const outcome = outcomes[index] ?? "ok";
      // Два ответа "running", потом исход — как на настоящем шлюзе.
      const status = seen < 3 ? "running" : outcome === "ok" ? "succeeded" : "failed";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id, status, error: status === "failed" ? "worker died" : null }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get submits() {
      return submits;
    },
    close: () => new Promise<void>(resolve => server.close(() => resolve())),
  };
}

function tmpOut(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ndemo-ailab-")), "seg.mp3");
}

function run(gateway: string, args: string[], text: string, env: Record<string, string> = {}) {
  return execa(SCRIPT, args, {
    input: text,
    env: {
      AILAB_BASE_URL: gateway,
      AILAB_API_KEY: "test-key",
      AILAB_POLL_SECONDS: "0.2",
      AILAB_POLL_LIMIT: "10",
      ...env,
    },
    reject: false,
  });
}

test("успешное задание превращается в непустой mp3", async () => {
  const gw = await fakeGateway(["ok"]);
  const out = tmpOut();
  const result = await run(gw.url, ["--voice", "vpc_test", "--speed", "0.9", "--out", out], "Проверка озвучки.");
  await gw.close();

  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(fs.statSync(out).size > 0);

  // ffmpeg по умолчанию пишет в mp3 тег ID3v2, поэтому файл начинается с "ID3",
  // а не с фрейм-синка. Принимаем оба варианта — проверка ловит подмену формата,
  // а не конкретную версию муксера.
  const head = fs.readFileSync(out);
  const isId3 = head.subarray(0, 3).toString("latin1") === "ID3";
  const isFrameSync = head[0] === 0xff && (head[1] & 0xe0) === 0xe0;
  assert.ok(isId3 || isFrameSync, `ожидался mp3, получено ${head.subarray(0, 4).toString("hex")}`);
});

test("упавшее задание повторяется ровно один раз и на втором успехе проходит", async () => {
  const gw = await fakeGateway(["failed", "ok"]);
  const out = tmpOut();
  const result = await run(gw.url, ["--voice", "vpc_test", "--speed", "1.0", "--out", out], "Текст.");
  const submits = gw.submits;
  await gw.close();

  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(submits, 2);
  assert.ok(fs.statSync(out).size > 0);
});

test("два подряд провала — ненулевой код и внятное сообщение", async () => {
  const gw = await fakeGateway(["failed", "failed"]);
  const out = tmpOut();
  const result = await run(gw.url, ["--voice", "vpc_test", "--speed", "1.0", "--out", out], "Текст.");
  const submits = gw.submits;
  await gw.close();

  assert.notEqual(result.exitCode, 0);
  assert.equal(submits, 2, "повтор должен быть ровно один");
  assert.match(result.stderr, /after one retry/);
  assert.equal(fs.existsSync(out), false);
});

test("голос не из профилей отбивается до обращения к шлюзу", async () => {
  const gw = await fakeGateway(["ok"]);
  const out = tmpOut();
  const result = await run(gw.url, ["--voice", "alloy", "--speed", "1.0", "--out", out], "Текст.");
  const submits = gw.submits;
  await gw.close();

  assert.notEqual(result.exitCode, 0);
  assert.equal(submits, 0);
  assert.match(result.stderr, /vpc_/);
});

test("без AILAB_API_KEY скрипт падает до сети", async () => {
  const gw = await fakeGateway(["ok"]);
  const out = tmpOut();
  const result = await run(gw.url, ["--voice", "vpc_test", "--speed", "1.0", "--out", out], "Текст.", {
    AILAB_API_KEY: "",
  });
  const submits = gw.submits;
  await gw.close();

  assert.notEqual(result.exitCode, 0);
  assert.equal(submits, 0);
  assert.match(result.stderr, /AILAB_API_KEY/);
});

test("сорванная конвертация не оставляет ни --out, ни .part рядом с ним", async () => {
  // Шлюз отдаёт на /output не wav, а произвольный текст: проверку [ -s "$WAV" ]
  // в скрипте он пройдёт (файл непустой), а вот ffmpeg декодировать его не сможет —
  // это доводит скрипт до срыва конвертации, не трогая сам скрипт.
  const gw = await fakeGateway(["ok"], Buffer.from("это не wav, а произвольный текст"));
  const out = tmpOut();
  const result = await run(gw.url, ["--voice", "vpc_test", "--speed", "1.0", "--out", out], "Текст.");
  await gw.close();

  assert.notEqual(result.exitCode, 0);
  assert.equal(fs.existsSync(out), false, "оборванный/невалидный файл не должен появляться по итоговому пути");
  assert.equal(fs.existsSync(`${out}.part`), false, "временный .part должен быть убран trap'ом на EXIT");
});
