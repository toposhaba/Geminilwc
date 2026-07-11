# Chrome Gemini Nano LWC

Salesforce Lightning Web Components that run LLMs **fully on-device**, with no server round-trip:

- **`geminiChat`** — a chat UI backed by Chrome's built-in Gemini Nano, with a client-side Transformers.js fallback.
- **`visionOcr`** — extracts text from images (OCR) using on-device vision models. A browser-native port of the [Ollama-OCR](https://github.com/imanoop7/Ollama-OCR) Python project.

## geminiChat

Runs an LLM fully on-device:

1. **Primary engine:** Google's Gemini Nano via [Chrome's built-in Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (stable for all websites since Chrome 148).
2. **Fallback engine:** when the Prompt API is unavailable (other browsers, older Chrome, unsupported hardware), the component can load a small open model (default `onnx-community/Qwen2.5-0.5B-Instruct`) that runs client-side via [Transformers.js](https://huggingface.co/docs/transformers.js), using WebGPU when available and WASM otherwise.

In both modes, prompts and responses never leave the user's machine.

## visionOcr (Ollama-OCR port)

A JavaScript/browser port of [Ollama-OCR](https://github.com/imanoop7/Ollama-OCR): upload an image and extract its text with a vision LLM, using the same output-format prompts as the Python original (markdown, plain text, JSON, structured, key-value pairs, table, or a custom prompt) plus its language hint and JSON pretty-printing behavior.

Instead of requiring a Python backend, it supports three engines, all local to the user's machine:

| Engine                        | What runs it                                                                                                                                                        | Requirements                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Chrome built-in Gemini Nano   | Prompt API multimodal image input                                                                                                                                   | Desktop Chrome 148+, capable hardware             |
| Local model (Transformers.js) | `HuggingFaceTB/SmolVLM-256M-Instruct` (configurable) in the engine iframe, WebGPU or WASM                                                                           | Any modern desktop browser                        |
| Ollama server                 | The user's own Ollama at `http://localhost:11434` (default model `llama3.2-vision:11b`), streamed via `/api/generate` — the direct equivalent of the Python package | Ollama running locally with a vision model pulled |

The default engine mode is **Auto**: Gemini Nano when available, otherwise the Transformers.js model.

**Ollama engine caveats:** the browser calls Ollama directly, so Ollama must allow cross-origin requests from the Lightning static resource origin — start it with `OLLAMA_ORIGINS=*` (or the specific origin). Chrome may also show a Local Network Access permission prompt the first time the page contacts `localhost`.

**Not ported:** PDF-to-image conversion, OpenCV preprocessing (contrast/denoise/threshold), and batch directory processing from the Python original. Single images (PNG/JPEG/WebP) are supported.

## What geminiChat does

- Detects whether the built-in Prompt API and Gemini Nano are available on the device.
- Triggers and reports on-device model download with a progress bar.
- Offers the Transformers.js fallback model when Gemini Nano is unavailable.
- Streams responses token-by-token into a chat UI in both modes.
- Supports a configurable system prompt, plus stop and clear controls.

## Architecture

| Piece                            | Purpose                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `lwc/geminiChat`                 | Chat UI, engine selection, Prompt API session management                                                                       |
| `lwc/visionOcr`                  | OCR UI: image upload, format/engine selection, streaming result                                                                |
| `lwc/ocrPrompts`                 | Service module with the OCR prompt templates ported from Ollama-OCR                                                            |
| `lwc/localLlmRunner`             | Headless service component that owns the engine iframe and exposes `initialize()`, `generate()`, `ollamaGenerate()`, `stop()`  |
| `staticresources/localLlmEngine` | Sandboxed iframe page that loads Transformers.js (text and vision models) and proxies streaming calls to a local Ollama server |

The fallback engine runs inside an iframe served from a static resource because Lightning's Content Security Policy and Lightning Web Security prevent loading third-party ML runtimes directly inside an LWC. The iframe has its own browsing context, so it can load Transformers.js from jsDelivr, fetch model weights from the Hugging Face Hub, and use WebGPU. The LWC communicates with it over `postMessage` using a namespaced protocol; model weights are cached by the browser after the first load.

The fallback model is configurable per page via the **Fallback model** property in Lightning App Builder (any ONNX-converted chat model on the Hugging Face Hub).

## Requirements (client / browser)

**Primary (Gemini Nano):** desktop Chrome 148+ with sufficient hardware (several GB free disk, >4 GB VRAM or equivalent). No flags or origin trial needed. The model downloads on first use, triggered by a user gesture.

**Fallback (Transformers.js):** any modern desktop browser. The iframe needs network access to `cdn.jsdelivr.net` (library) and `huggingface.co` / `cas-bridge.xethub.hf.co` (model weights) from the user's machine. WebGPU accelerates inference where available; otherwise it runs on single-threaded WASM (noticeably slower — keep the fallback model small).

## Develop

```bash
npm install
npm run lint
npm run test:unit
```

## Deploy to a Salesforce org

```bash
# Authorize an org
sf org login web --alias myOrg

# Deploy the component
sf project deploy start --source-dir force-app --target-org myOrg
```

Then add the **Gemini Nano Chat** or **Vision OCR (On-Device)** component to any Lightning App/Home/Record page via the Lightning App Builder, or drop them into an Experience Cloud page.

## Notes on Lightning Web Security

The component accesses the built-in AI globals (`window.LanguageModel`, with a fallback to the legacy `window.ai.languageModel`) through `window`, which is compatible with Lightning Web Security (LWS). The Transformers.js fallback deliberately avoids the LWS sandbox entirely by running in its own iframe.

## Privacy

Both engines run inference locally in the browser. Prompts and responses are not sent to Salesforce servers, Google, or Hugging Face — the only network traffic is the one-time download of the model weights.
