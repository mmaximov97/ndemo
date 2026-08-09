import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildCommand, runCommandProvider } from "./tts.js";

function tmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ndemo-tts-"));
}

test("buildCommand подставляет все четыре плейсхолдера", () => {
  const command = buildCommand(
    "{{skillDir}}/contrib/ailab-tts.sh --voice {{voice}} --speed {{speed}} --out {{out}}",
    { out: "/o/intro.mp3", voice: "vpc_abc", speed: "0.9", skillDir: "/skill" }
  );
  assert.equal(
    command,
    "/skill/contrib/ailab-tts.sh --voice vpc_abc --speed 0.9 --out /o/intro.mp3"
  );
});

test("текст закадра идёт через stdin и не исполняется шеллом", async () => {
  const dir = tmpdir();
  const out = path.join(dir, "intro.mp3");
  const marker = path.join(dir, "PWNED");
  const narration = `Реплика с "кавычками", $(touch ${marker}), 'апострофом'
и переводом строки`;

  await runCommandProvider(`cat > ${out}`, narration, out);

  assert.equal(fs.readFileSync(out, "utf8"), narration);
  assert.equal(fs.existsSync(marker), false, "подстановка текста в шелл — инъекция");
});

test("нулевой код выхода без файла — ошибка", async () => {
  const dir = tmpdir();
  const out = path.join(dir, "intro.mp3");
  await assert.rejects(
    () => runCommandProvider("true", "текст", out),
    /wrote no audio/
  );
});

test("пустой файл считается провалом, а не успехом", async () => {
  const dir = tmpdir();
  const out = path.join(dir, "intro.mp3");
  await assert.rejects(
    () => runCommandProvider(`: > ${out}`, "текст", out),
    /wrote no audio/
  );
});

test("ненулевой код выхода — ошибка с хвостом stderr", async () => {
  const dir = tmpdir();
  const out = path.join(dir, "intro.mp3");
  await assert.rejects(
    () => runCommandProvider(`echo "нет такого профиля" >&2; exit 3`, "текст", out),
    /нет такого профиля/
  );
});
