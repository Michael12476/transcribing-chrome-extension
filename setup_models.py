"""Set up the user's own local models: the chosen Whisper model and two Argos translation models."""
import json
import hashlib
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
PACKAGES = {
    "en_it": ("https://argos-net.com/v1/translate-en_it-1_0.argosmodel", "dde2180001a47904ecbbd688a41e35db8a040e4fd5b52e4f29b4bb499516ab32"),
    "it_en": ("https://argos-net.com/v1/translate-it_en-1_0.argosmodel", "d2dd23b8b702f612b8127f07c7a0391f5f2a8b93344e6ddc9dd93c81824e85cb"),
}


def setup_whisper(name):
    """Download a faster-whisper model by name, or accept a local CTranslate2 model folder."""
    if Path(name).is_dir():
        # Chrome starts the host from another folder, so store an absolute path.
        name = str(Path(name).resolve())
        if not (Path(name) / "model.bin").is_file():
            raise SystemExit("That folder is not a faster-whisper model: it has no model.bin.")
        print("Using your local Whisper model folder:", name, flush=True)
    else:
        from faster_whisper.utils import download_model
        print("Downloading Whisper model to this computer:", name, flush=True)
        print("Model ready:", download_model(name), flush=True)
    (HERE / "config.json").write_text(json.dumps({"whisper_model": name}), encoding="utf-8")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("Usage: setup_models.py <whisper model name or folder>")
    setup_whisper(sys.argv[1])
    for direction, (url, expected_hash) in PACKAGES.items():
        destination = HERE / "models" / direction
        if (destination / "model/model.bin").is_file() and (destination / "sentencepiece.model").is_file():
            print("Already installed:", direction, flush=True)
            continue
        print("Downloading local translation model:", direction, flush=True)
        with tempfile.TemporaryDirectory(prefix="video-transcripts-") as temporary:
            archive = Path(temporary) / "model.zip"
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(request, timeout=120) as response, archive.open("wb") as output:
                shutil.copyfileobj(response, output)
            with archive.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != expected_hash:
                    raise ValueError(f"Translation package {direction} failed its integrity check.")
            staged = Path(temporary) / "extracted"
            staged.mkdir()
            with zipfile.ZipFile(archive) as package:
                for member in package.infolist():
                    parts = Path(member.filename).parts[1:]
                    if not parts or member.is_dir():
                        continue
                    if parts[0] not in ("model", "sentencepiece.model", "metadata.json", "LICENSE"):
                        continue
                    target = (staged / Path(*parts)).resolve()
                    if not target.is_relative_to(staged.resolve()):
                        raise ValueError("Unsafe model archive path.")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with package.open(member) as source, target.open("wb") as output:
                        shutil.copyfileobj(source, output)
            if not (staged / "model/model.bin").is_file() or not (staged / "sentencepiece.model").is_file():
                raise ValueError(f"Translation package {direction} is incomplete.")
            metadata = json.loads((staged / "metadata.json").read_text(encoding="utf-8"))
            if f"{metadata['from_code']}_{metadata['to_code']}" != direction:
                raise ValueError("Translation package has the wrong language pair.")
            destination.parent.mkdir(exist_ok=True)
            shutil.copytree(staged, destination, dirs_exist_ok=True)
    print("Transcription and both translation directions are ready. No cloud service is used.", flush=True)


if __name__ == "__main__":
    main()
