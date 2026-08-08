#!/usr/bin/env python
"""
GPU-accelerated subtitle extraction using faster-whisper.
Called by the Electron main process.

Usage:
    python extract_subtitle.py <audio_file> [--model tiny] [--device cuda] [--compute-type float16]

Outputs SRT to stdout (or to <output_file> if specified).
Progress is reported to stderr as JSON: {"type":"progress","progress":50,"message":"..."}
"""

import sys
import os
import json
import argparse
import time

def emit_progress(progress, message):
    """Send progress to stderr as JSON for the parent process to capture."""
    print(json.dumps({"type": "progress", "progress": progress, "message": message}), file=sys.stderr, flush=True)

def format_timestamp(seconds):
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millis = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"

def main():
    parser = argparse.ArgumentParser(description="Extract subtitles using faster-whisper")
    parser.add_argument("audio_file", help="Path to audio file (wav/mp3/etc)")
    parser.add_argument("--model", default="tiny", help="Model size: tiny, base, small, medium, large-v3")
    parser.add_argument("--device", default="auto", help="Device: cuda, cpu, auto")
    parser.add_argument("--compute-type", default="auto", help="Compute type: float16, int8_float16, int8, auto")
    parser.add_argument("--language", default="zh", help="Language code (zh, en, auto)")
    parser.add_argument("--output", help="Output SRT file path")
    args = parser.parse_args()

    if not os.path.exists(args.audio_file):
        print(f'{{"type":"error","message":"Audio file not found: {args.audio_file}"}}', file=sys.stderr)
        sys.exit(1)

    # Determine device
    device = args.device
    compute_type = args.compute_type

    if device == "auto":
        try:
            import ctranslate2
            if ctranslate2.get_cuda_device_count() > 0:
                device = "cuda"
                compute_type = compute_type if compute_type != "auto" else "float16"
            else:
                device = "cpu"
                compute_type = compute_type if compute_type != "auto" else "int8"
        except:
            device = "cpu"
            compute_type = "int8"

    emit_progress(10, f"加载模型 ({device}/{compute_type}/{args.model})...")

    from faster_whisper import WhisperModel

    model_cache = os.path.join(
        os.environ.get("WHISPER_CACHE_DIR",
                       os.path.join(os.path.expanduser("~"), ".cache", "whisper")),
        "models"
    )
    os.makedirs(model_cache, exist_ok=True)

    start_time = time.time()

    model = WhisperModel(
        args.model,
        device=device,
        compute_type=compute_type,
        download_root=model_cache
    )

    emit_progress(30, f"模型加载完成 ({time.time()-start_time:.1f}s)，开始识别...")

    transcribe_start = time.time()

    segments, info = model.transcribe(
        args.audio_file,
        language=args.language if args.language != "auto" else None,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500)
    )

    # Generate SRT — iterate segments (this triggers actual computation)
    srt_lines = []
    segment_count = 0
    total_duration = info.duration
    for segment in segments:
        segment_count += 1
        srt_lines.append(str(segment_count))
        srt_lines.append(f"{format_timestamp(segment.start)} --> {format_timestamp(segment.end)}")
        srt_lines.append(segment.text.strip())
        srt_lines.append("")

        # Report progress based on segment end time
        pct = 30 + min(65, int(segment.end / total_duration * 65)) if total_duration > 0 else 30
        if segment_count % 10 == 0:
            emit_progress(pct, f"识别中... {segment_count} 段 ({segment.end:.0f}s/{total_duration:.0f}s)")

    elapsed = time.time() - transcribe_start
    emit_progress(95, f"识别完成: {segment_count} 段, {elapsed:.1f}s ({total_duration/elapsed:.1f}x)")

    srt_content = "\n".join(srt_lines)

    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(srt_content)
        emit_progress(100, f"字幕已保存: {args.output}")
    else:
        print(srt_content)

if __name__ == "__main__":
    main()
