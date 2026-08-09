import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import OpenAI from "openai";
import type { Playbook, Segment } from "./schema.js";

interface TtsResult {
  audioPath: string;
  durationMs: number;
}

function ttsHash(narration: string, voice: string, speed: number): string {
  return crypto
    .createHash("sha256")
    .update(narration + voice + speed)
    .digest("hex")
    .slice(0, 8);
}

/**
 * Find existing audio file for a segment ID in the given directory.
 * Files are named `{id}-{hash}.mp3`.
 */
function findAudioFile(audioDir: string, segmentId: string): string | null {
  if (!fs.existsSync(audioDir)) return null;
  const prefix = `${segmentId}-`;
  const files = fs.readdirSync(audioDir);
  const match = files.find(f => f.startsWith(prefix) && f.endsWith(".mp3"));
  return match ? path.join(audioDir, match) : null;
}

/**
 * Delete any stale audio files for a segment ID that don't match the current hash.
 */
function cleanStaleAudio(audioDir: string, segmentId: string, currentHash: string): void {
  if (!fs.existsSync(audioDir)) return;
  const currentName = `${segmentId}-${currentHash}.mp3`;
  const prefix = `${segmentId}-`;
  for (const file of fs.readdirSync(audioDir)) {
    if (file.startsWith(prefix) && file.endsWith(".mp3") && file !== currentName) {
      fs.unlinkSync(path.join(audioDir, file));
    }
  }
}

/** Корень установки тулкита: dist/tts.js → директория с package.json. */
function skillDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

interface CommandVars {
  out: string;
  voice: string;
  speed: string;
  skillDir: string;
}

/**
 * Подставляет в строку запуска только безопасные значения. Текста закадра
 * здесь нет намеренно: он многострочный и произвольный, и попадание его в
 * командную строку было бы инъекцией через содержимое плейбука.
 */
function buildCommand(template: string, vars: CommandVars): string {
  return template.replace(
    /\{\{(out|voice|speed|skillDir)\}\}/g,
    (_match, key: keyof CommandVars) => vars[key]
  );
}

/**
 * Запускает внешнюю программу синтеза. Текст идёт в stdin, путь выходного
 * файла диктует ndemo. stderr одновременно показывается пользователю (это
 * единственный признак жизни во время долгого синтеза) и запоминается, чтобы
 * попасть в сообщение об ошибке.
 */
async function runCommandProvider(
  command: string,
  narration: string,
  audioPath: string
): Promise<void> {
  try {
    await execa(command, {
      shell: true,
      input: narration,
      stderr: ["inherit", "pipe"],
      // Потолок на зависший скрипт. Сам скрипт держит лимит меньше: 6 минут
      // на попытку и один повтор, который в FIFO-очереди шлюза может встать
      // за всё ещё считающимся первым джобом.
      timeout: 15 * 60 * 1000,
    });
  } catch (error) {
    const err = error as { exitCode?: number; stderr?: string };
    const tail = String(err.stderr ?? "").trim().split("\n").slice(-5).join("\n");
    throw new Error(
      `TTS command failed (exit ${err.exitCode ?? "?"}):\n  ${command}\n${tail}`
    );
  }

  if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
    throw new Error(`TTS command exited 0 but wrote no audio to ${audioPath}\n  ${command}`);
  }
}

/**
 * Ensure TTS audio exists for a segment, regenerating if narration/voice/speed changed.
 * Deletes stale audio files automatically.
 */
async function ensureAudio(
  segment: Segment,
  playbook: Playbook,
  outputDir: string
): Promise<TtsResult> {
  const audioDir = path.join(outputDir, "audio");
  fs.mkdirSync(audioDir, { recursive: true });

  const hash = ttsHash(segment.narration!, playbook.tts.voice, playbook.tts.speed);
  const audioPath = path.join(audioDir, `${segment.id}-${hash}.mp3`);

  // Clean up stale files for this segment
  cleanStaleAudio(audioDir, segment.id, hash);

  // If current file exists, just probe and return
  if (fs.existsSync(audioPath)) {
    const durationMs = await probeDuration(audioPath);
    return { audioPath, durationMs };
  }

  // Generate new audio
  if (playbook.tts.provider === "openai") {
    const openai = new OpenAI();
    const response = await openai.audio.speech.create({
      model: "tts-1-hd",
      voice: playbook.tts.voice as any,
      speed: playbook.tts.speed,
      input: segment.narration!,
      response_format: "mp3",
    });

    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(audioPath, new Uint8Array(arrayBuffer));
  } else if (playbook.tts.provider === "command") {
    const command = buildCommand(playbook.tts.command!, {
      out: audioPath,
      voice: playbook.tts.voice,
      speed: String(playbook.tts.speed),
      skillDir: skillDir(),
    });
    await runCommandProvider(command, segment.narration!, audioPath);
  } else {
    throw new Error(`TTS provider "${playbook.tts.provider}" not yet implemented`);
  }

  const durationMs = await probeDuration(audioPath);
  return { audioPath, durationMs };
}

async function probeDuration(audioPath: string): Promise<number> {
  const { stdout } = await execa("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "csv=p=0",
    audioPath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (isNaN(seconds)) {
    throw new Error(`Could not probe duration of ${audioPath}`);
  }
  return Math.round(seconds * 1000);
}

// Keep generateTts as an alias for ensureAudio for backwards compat within renderer
const generateTts = ensureAudio;

export { generateTts, ensureAudio, probeDuration, ttsHash, findAudioFile, buildCommand, runCommandProvider, skillDir };
