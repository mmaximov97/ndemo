#!/usr/bin/env bash
# Синтез закадра через self-hosted шлюз ai-lab — для провайдера `command` в ndemo.
#
# Текст читается из stdin, результат кладётся в --out в формате mp3.
#
#   printf '%s' "текст" | ailab-tts.sh --voice vpc_… --speed 0.9 --out out.mp3
#
# Окружение: AILAB_BASE_URL, AILAB_API_KEY (обязательные);
# AILAB_POLL_SECONDS, AILAB_POLL_LIMIT, AILAB_TTS_MODEL, AILAB_TTS_LANG.
set -euo pipefail

BASE="${AILAB_BASE_URL:-}"
KEY="${AILAB_API_KEY:-}"
POLL="${AILAB_POLL_SECONDS:-5}"
LIMIT="${AILAB_POLL_LIMIT:-72}"          # 72 × 5 с = 6 минут на попытку
MODEL="${AILAB_TTS_MODEL:-local/qwen-tts}"
SPEECH_LANG="${AILAB_TTS_LANG:-ru}"
VOICE=""
SPEED="1.0"
OUT=""

die() { echo "ailab-tts: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --voice) VOICE="$2"; shift 2 ;;
    --speed) SPEED="$2"; shift 2 ;;
    --out)   OUT="$2";   shift 2 ;;
    -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$BASE" ] || die "AILAB_BASE_URL is not set"
[ -n "$KEY" ]  || die "AILAB_API_KEY is not set"
[ -n "$OUT" ]  || die "--out is required"
command -v curl   >/dev/null || die "curl is required"
command -v jq     >/dev/null || die "jq is required"
command -v ffmpeg >/dev/null || die "ffmpeg is required (wav to mp3 conversion)"

# У qwen-tts нет встроенных голосов: голос задаётся клонированным профилем.
# Ловим здесь, иначе шлюз ответит непрозрачным 400.
case "$VOICE" in
  vpc_*) ;;
  *) die "voice must be a vpc_ profile — qwen-tts has no built-in voices (got: '$VOICE')" ;;
esac

# atempo вне 0.5–2.0 ffmpeg не примет.
awk -v t="$SPEED" 'BEGIN{exit !(t>=0.5 && t<=2.0)}' </dev/null \
  || die "--speed must be within 0.5-2.0 (got: $SPEED)"

TEXT="$(cat)"
[ -n "$TEXT" ] || die "empty text on stdin"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
WAV="$TMP/raw.wav"

synth_once() {
  local submit job status seen

  submit=$(jq -nc --arg m "$MODEL" --arg v "$VOICE" --arg i "$TEXT" --arg l "$SPEECH_LANG" \
      '{model:$m, voice:$v, input:$i, language:$l}' \
    | curl -sS -X POST "$BASE/v1/audio/speech" \
        -H "authorization: Bearer $KEY" -H "content-type: application/json" \
        --data-binary @-) || { echo "ailab-tts: gateway $BASE unreachable" >&2; return 1; }

  job=$(printf '%s' "$submit" | jq -r '.id // empty')
  if [ -z "$job" ]; then
    case "$submit" in
      *forbidden*) echo "ailab-tts: forbidden — the key belongs to another project and cannot use profile $VOICE" >&2 ;;
      *) echo "ailab-tts: gateway returned no job id: $submit" >&2 ;;
    esac
    return 1
  fi

  echo "ailab-tts: job $job — synthesizing (~40s per segment, the gateway runs one job at a time)" >&2

  seen=0
  while [ "$seen" -lt "$LIMIT" ]; do
    sleep "$POLL"
    seen=$((seen + 1))
    status=$(curl -sS "$BASE/v1/jobs/$job" -H "authorization: Bearer $KEY" | jq -r '.status // "unknown"')
    case "$status" in
      succeeded)
        curl -sS "$BASE/v1/jobs/$job/output" -H "authorization: Bearer $KEY" -o "$WAV"
        [ -s "$WAV" ] || { echo "ailab-tts: gateway returned an empty file for $job" >&2; return 1; }
        return 0 ;;
      failed)
        echo "ailab-tts: job $job failed on the gateway" >&2
        return 1 ;;
    esac
  done

  echo "ailab-tts: $job did not finish in time — check GET $BASE/v1/jobs/$job" >&2
  return 1
}

if ! synth_once; then
  # Очередь на шлюзе одна и FIFO: если первый джоб ещё считается, повтор
  # встанет за ним, и ожидание сложится из двух лимитов.
  echo "ailab-tts: retrying once" >&2
  synth_once || die "synthesis failed after one retry"
fi

mkdir -p "$(dirname "$OUT")"
# У qwen-tts нет параметра скорости — темп меняется только здесь. atempo
# сохраняет высоту тона, поэтому голос остаётся собой.
ffmpeg -nostdin -loglevel error -y -i "$WAV" -filter:a "atempo=$SPEED" \
  -c:a libmp3lame -q:a 4 "$OUT"
[ -s "$OUT" ] || die "ffmpeg did not produce $OUT"
