"""Chrome native messaging host. Audio and text never leave this computer."""
import base64
import glob
import json
import math
import os
from pathlib import Path
import struct
import sys

HERE = Path(__file__).resolve().parent
RATE = 16000
MAX_MESSAGE = 1024 * 1024
CONFIG = HERE / "config.json"
SETUP_HINT = "Set up your local model: run install.ps1 in the transcribing-chrome-extension folder."


def read_message(stream):
    header = stream.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise ValueError("Incomplete native message header.")
    length = struct.unpack("<I", header)[0]
    if not 0 < length <= MAX_MESSAGE:
        raise ValueError("Native message is too large.")
    data = stream.read(length)
    if len(data) != length:
        raise ValueError("Incomplete native message body.")
    message = json.loads(data)
    if not isinstance(message, dict):
        raise ValueError("Expected a message object.")
    return message


def write_message(stream, message):
    data = json.dumps(message, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("<I", len(data)) + data)
    stream.flush()


def decode_audio(message):
    import numpy as np
    pcm = base64.b64decode(message["pcm"], validate=True)
    if not pcm or len(pcm) % 4 or len(pcm) > RATE * 8 * 4:
        raise ValueError("Expected at most 8 seconds of 16 kHz float32 audio.")
    audio = np.frombuffer(pcm, dtype="<f4")
    if not np.all(np.isfinite(audio)):
        raise ValueError("Audio contains invalid samples.")
    offset = message["offset"]
    if isinstance(offset, bool) or not isinstance(offset, (int, float)) or not math.isfinite(offset) or offset < 0:
        raise ValueError("Invalid audio timestamp.")
    return np.clip(audio, -1, 1), offset


def whisper_model():
    """The Whisper model the user chose in install.ps1: a faster-whisper name or a local model folder."""
    if not CONFIG.is_file():
        raise ValueError("No transcription model is set up yet.")
    name = json.loads(CONFIG.read_text(encoding="utf-8")).get("whisper_model")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("config.json has no whisper_model.")
    return name


def check_setup():
    try:
        from faster_whisper.utils import download_model
        name = whisper_model()
        if Path(name).is_dir():
            if not (Path(name) / "model.bin").is_file():
                raise ValueError(f"{name} has no model.bin.")
        else:
            download_model(name, local_files_only=True)
        for pair in ("it_en", "en_it"):
            folder = HERE / "models" / pair
            if not (folder / "model/model.bin").is_file() or not (folder / "sentencepiece.model").is_file():
                raise ValueError(f"The {pair} translation model is missing.")
    except Exception as error:
        return {"type": "setup", "ok": False, "error": f"{str(error).rstrip('.')}. {SETUP_HINT}"}
    return {"type": "setup", "ok": True, "model": name}


def load_models(language, with_translation=True):
    if language not in ("it", "en"):
        raise ValueError("Choose Italian or English.")
    if not isinstance(with_translation, bool):
        raise ValueError("Choose a valid transcription mode.")
    dll_handles = []
    for folder in glob.glob(str(Path(sys.prefix) / "Lib/site-packages/nvidia/*/bin")):
        if os.name == "nt":
            dll_handles.append(os.add_dll_directory(folder))
        os.environ["PATH"] = folder + os.pathsep + os.environ["PATH"]
    import ctranslate2
    from faster_whisper import WhisperModel
    translator = tokenizer = None
    if with_translation:
        import sentencepiece as spm
        target = "en" if language == "it" else "it"
        model_dir = HERE / "models" / f"{language}_{target}"
        tokenizer = spm.SentencePieceProcessor(model_file=str(model_dir / "sentencepiece.model"))
        translator = ctranslate2.Translator(str(model_dir / "model"), device="cpu", compute_type="int8", intra_threads=4)
    gpu = ctranslate2.get_cuda_device_count() > 0
    whisper = WhisperModel(whisper_model(), device="cuda" if gpu else "cpu",
                           compute_type="int8_float16" if gpu else "int8", local_files_only=True)
    # Keep DLL directory handles alive while the models are in use.
    return whisper, translator, tokenizer, dll_handles


def translate(text, translator, tokenizer):
    if translator is None or not text.strip():
        return ""
    tokens = tokenizer.encode(text, out_type=str)
    result = translator.translate_batch([tokens], beam_size=4, max_decoding_length=256)[0]
    return tokenizer.decode(result.hypotheses[0]).strip()


def transcribe(message, language, whisper, translator, tokenizer):
    audio, offset = decode_audio(message)
    segments, _ = whisper.transcribe(audio, language=language, vad_filter=True, beam_size=1,
                                    condition_on_previous_text=False)
    original = " ".join(segment.text.strip() for segment in segments).strip()
    return {"type": "result", "offset": offset, "duration": len(audio) / RATE,
            "original": original, "translation": translate(original, translator, tokenizer)}


def main():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    incoming, outgoing = sys.stdin.buffer, sys.stdout.buffer
    # Third-party imports must never write unframed output into Chrome's protocol.
    sys.stdout = sys.stderr
    try:
        init = read_message(incoming)
        if init is None:
            return
        if init.get("type") == "check":
            write_message(outgoing, check_setup())
            return
        if init.get("type") != "init":
            raise ValueError("Initialize the transcription language first.")
        language = init.get("language")
        whisper, translator, tokenizer, dll_handles = load_models(language, init.get("translate", True))
        write_message(outgoing, {"type": "ready"})
        while (message := read_message(incoming)) is not None:
            if message.get("type") != "audio":
                raise ValueError("Expected an audio message.")
            write_message(outgoing, transcribe(message, language, whisper, translator, tokenizer))
    except Exception as error:
        write_message(outgoing, {"type": "error", "error": f"Local transcription failed: {error}. {SETUP_HINT}"})


if __name__ == "__main__":
    main()
