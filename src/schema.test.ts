import { test } from "node:test";
import assert from "node:assert/strict";
import { PlaybookSchema } from "./schema.js";

const base = {
  app: { url: "http://localhost:5173" },
  segments: [{ id: "intro", intent: "показать список компаний" }],
};

test("provider command без tts.command не проходит валидацию", () => {
  const result = PlaybookSchema.safeParse({ ...base, tts: { provider: "command" } });
  assert.equal(result.success, false);
  assert.match(JSON.stringify(result.error!.issues), /requires tts\.command/);
});

test("provider command с командой проходит и сохраняет её", () => {
  const result = PlaybookSchema.safeParse({
    ...base,
    tts: { provider: "command", command: "./tts.sh --out {{out}}" },
  });
  assert.equal(result.success, true);
  assert.equal(result.data!.tts.command, "./tts.sh --out {{out}}");
});

test("плейбук без секции tts по-прежнему получает openai по умолчанию", () => {
  const result = PlaybookSchema.safeParse(base);
  assert.equal(result.success, true);
  assert.equal(result.data!.tts.provider, "openai");
  assert.equal(result.data!.tts.voice, "alloy");
});
