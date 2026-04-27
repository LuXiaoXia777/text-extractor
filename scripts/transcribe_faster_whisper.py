import json
import os
import sys

from faster_whisper import WhisperModel


def main():
    if len(sys.argv) < 3:
      raise SystemExit("usage: transcribe_faster_whisper.py <audio_path> <model_name>")

    audio_path = sys.argv[1]
    model_name = sys.argv[2]
    device = os.getenv("FASTER_WHISPER_DEVICE", "cpu")
    compute_type = os.getenv("FASTER_WHISPER_COMPUTE_TYPE", "int8")

    model = WhisperModel(model_name, device=device, compute_type=compute_type)
    segments, info = model.transcribe(
        audio_path,
        language="zh",
        vad_filter=True,
        beam_size=5,
        condition_on_previous_text=False,
    )

    texts = []
    count = 0
    for segment in segments:
        text = (segment.text or "").strip()
        if text:
            texts.append(text)
        count += 1

    print(
        json.dumps(
            {
                "transcript": "\n".join(texts),
                "model": model_name,
                "language": getattr(info, "language", "") or "",
                "duration": getattr(info, "duration", 0) or 0,
                "segment_count": count,
                "warning": "",
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
