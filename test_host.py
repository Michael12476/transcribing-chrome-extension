"""Run with the .venv Python. Add --models <English speech file> to check the installed models (needs ffmpeg)."""
import base64
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

import numpy as np
import host


def rejects(function, *arguments):
    try:
        function(*arguments)
    except (ValueError, KeyError, TypeError):
        return
    raise AssertionError("Invalid input was accepted")


def check_protocol():
    stream = io.BytesIO()
    host.write_message(stream, {"text": "Ciao, perché?"})
    stream.seek(0)
    assert host.read_message(stream) == {"text": "Ciao, perché?"}
    assert host.read_message(stream) is None
    rejects(host.read_message, io.BytesIO(b"\x01"))
    rejects(host.read_message, io.BytesIO(struct.pack("<I", host.MAX_MESSAGE + 1)))
    rejects(host.read_message, io.BytesIO(struct.pack("<I", 4) + b"{}"))
    rejects(host.read_message, io.BytesIO(struct.pack("<I", 2) + b"[]"))
    audio = np.zeros(host.RATE, dtype="<f4")
    message = {"pcm": base64.b64encode(audio.tobytes()).decode(), "offset": 8.5}
    decoded, offset = host.decode_audio(message)
    assert len(decoded) == host.RATE and offset == 8.5
    for invalid in (float("nan"), -1, True, "0"):
        rejects(host.decode_audio, {**message, "offset": invalid})
    rejects(host.decode_audio, {**message, "pcm": "!!!"})
    rejects(host.decode_audio, {**message, "pcm": base64.b64encode(b"x").decode()})
    rejects(host.decode_audio, {**message, "pcm": base64.b64encode(np.array([float("nan")], dtype="<f4").tobytes()).decode()})
    clipped, _ = host.decode_audio({**message, "pcm": base64.b64encode(np.array([1.2, -1.1], dtype="<f4").tobytes()).decode()})
    assert clipped.tolist() == [1, -1]
    for invalid in (None, "false", 0, 1, [], {}):
        rejects(host.load_models, "en", invalid)
    assert host.translate("Hello", None, None) == ""
    with patch.object(host, "CONFIG", Path("missing-config.json")):
        rejects(host.whisper_model)
        assert host.check_setup()["ok"] is False
    with tempfile.TemporaryDirectory() as empty:
        config = Path(empty) / "config.json"
        config.write_text(json.dumps({"whisper_model": empty}), encoding="utf-8")
        with patch.object(host, "CONFIG", config):
            assert "model.bin" in host.check_setup()["error"]
    print("Native framing and invalid audio checks passed.")


def check_models(sample):
    assert host.check_setup()["ok"], host.check_setup()
    pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", str(sample), "-t", "8", "-f", "f32le", "-ac", "1", "-ar", "16000", "-"], capture_output=True, check=True).stdout
    message = {"type": "audio", "pcm": base64.b64encode(pcm).decode(), "offset": 0}
    for language, text, expected in (("it", "Buongiorno, come stai?", "how"), ("en", "Good morning, how are you?", "come")):
        started = time.monotonic()
        whisper, translator, tokenizer, handles = host.load_models(language)
        translated = host.translate(text, translator, tokenizer)
        assert expected in translated.lower(), translated
        assert host.translate("", translator, tokenizer) == ""
        print(f"{language}: {text} -> {translated} ({time.monotonic() - started:.1f}s)")
        if language == "en":
            result = host.transcribe(message, "en", whisper, translator, tokenizer)
            assert result["original"], result
            assert result["translation"] and result["duration"] == 8, result
            print(json.dumps(result, ensure_ascii=False))
        del whisper, translator, tokenizer, handles
    with patch("ctranslate2.Translator", side_effect=AssertionError("English-only must not load a translator")):
        whisper, translator, tokenizer, handles = host.load_models("en", False)
        assert translator is None and tokenizer is None
        result = host.transcribe(message, "en", whisper, translator, tokenizer)
        assert result["original"] and result["translation"] == "", result
        print("English-only speech transcription passed without loading a translation model.")
        del whisper, translator, tokenizer, handles
    for with_translation in (True, False):
        messages = io.BytesIO()
        init = {"type": "init", "language": "en"}
        if not with_translation:
            init["translate"] = False
        host.write_message(messages, init)
        host.write_message(messages, message)
        process = subprocess.run([os.environ["COMSPEC"], "/d", "/c", str(host.HERE / "host.cmd")],
                                 input=messages.getvalue(), capture_output=True, timeout=90,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
        assert process.returncode == 0, process.stderr.decode(errors="replace")
        responses = io.BytesIO(process.stdout)
        assert host.read_message(responses) == {"type": "ready"}, process.stderr.decode(errors="replace")
        result = host.read_message(responses)
        assert result["type"] == "result" and result["original"], result
        assert bool(result["translation"]) == with_translation, result
        assert host.read_message(responses) is None
    print("Installed Windows launcher round trips passed with and without translation.")


if __name__ == "__main__":
    check_protocol()
    if "--models" in sys.argv:
        check_models(sys.argv[sys.argv.index("--models") + 1])
