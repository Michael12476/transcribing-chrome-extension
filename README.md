# Transcribing Chrome Extension

In Chrome it appears as **Video transcripts**.

A Chrome extension that transcribes the audio playing in a tab, or translates it between Italian and English. Everything runs on your computer.

**This extension does not include an AI model, and it does not use a cloud service.** You install a [Whisper](https://github.com/SYSTRAN/faster-whisper) model on your own computer, and the extension talks to it through Chrome's [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging). Until you do this, the side panel shows setup steps and **Start transcription** stays disabled.

Setup is Windows only for now.

## Set up your model

You need [Python 3.11 or newer](https://www.python.org/downloads/) on your PATH. An NVIDIA GPU is optional, but it makes large models much faster.

In PowerShell, from this folder:

```powershell
.\install.ps1
```

The script:

1. Creates a `.venv` in this folder and installs `faster-whisper` and `sentencepiece`. If it finds an NVIDIA GPU, it also installs the CUDA libraries (about 1 GB).
2. Asks which Whisper model to download: `small`, `medium`, `large-v3-turbo`, or the path of a faster-whisper (CTranslate2) model folder you already have. Your choice goes in `config.json`. To skip the question, run `.\install.ps1 -Model small`.
3. Downloads two [Argos translation models](https://github.com/argosopentech/argospm-index) (about 175 MB) and checks their SHA-256 hashes.
4. Registers the native messaging host `local.video_transcripts` under your Windows user account. The host only accepts connections from this extension's fixed ID, which comes from the `key` in `extension/manifest.json`.

Models download from Hugging Face and argos-net.com to your computer. This repository does not ship or host any model. To change models later, run `install.ps1` again.

## Load the extension

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**, then click **Load unpacked**.
3. Select the `extension` folder inside this folder.
4. Open a video website and click **Video transcripts** in Chrome's extension menu.
5. If the panel shows **Set up your transcription model**, finish the setup above and click **Check again**.
6. Choose **English → English**, **Italian → English**, or **English → Italian**. Click **Start transcription**, then play the audio or video.
7. Click **Stop & save** when you finish. Saved recordings appear under **Saved videos**.

Text saves automatically, even if you close the side panel. **English → English** saves one English transcript and does not load a translation model. The translation modes show the original and the translated text together. **Download text** exports the selected recording to a text file.

## What to expect

- It captures the audio playing in the selected tab, including audio-only players. To capture a whole recording, play it from the beginning.
- Click the extension's toolbar icon on each new tab before you press Start. A side panel that is already open does not grant access to a different tab.
- Speech appears in clips of up to eight seconds, plus model processing time. Translations can contain mistakes, so compare them with the original.
- Audio playback continues normally. The extension never uses the microphone.
- One video records at a time. Switching tabs does not switch the recording. Closing the captured tab ends it.
- Saved text stays in this Chrome profile. Uninstalling the extension or clearing its storage deletes the library, so download important transcripts.
- Sites with protected audio may block capture. Chrome's internal pages cannot be recorded.
- If you move this folder, run `install.ps1` again.

## How it works

No JavaScript packages or build step. The extension uses Chrome's [tab capture API](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture) and native messaging. It has no network or host permissions and does not run a local web server.

- `offscreen.js` captures the tab audio and cuts it into clips.
- `background.js` relays clips to the native host, because Chrome only allows native messaging from the service worker. It saves each finished clip to Chrome storage.
- `host.py` validates the message framing and audio, runs your Whisper model (on the GPU when one is available), and translates with CTranslate2 on the CPU when you choose a translation mode.

## Checks

```powershell
node .\test_extension.cjs
.\.venv\Scripts\python.exe .\test_host.py
.\.venv\Scripts\python.exe .\test_host.py --models C:\path\to\english-speech.wav
```

The `--models` check runs your installed models on a short English speech file. It needs `ffmpeg` on your PATH. `test_preview.py` serves the panel with fake data at `http://127.0.0.1:8875/panel.html` for UI work. Add `?setup` to the URL to see the setup prompt.

## Uninstall

Remove the extension in `chrome://extensions`, delete this folder, and remove the native host registration:

```powershell
Remove-Item -LiteralPath 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\local.video_transcripts'
```

Downloaded Whisper models stay in the Hugging Face cache (`%USERPROFILE%\.cache\huggingface`) until you delete them.

## License

[MIT](LICENSE)
