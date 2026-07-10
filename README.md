# Chrome Gemini Nano LWC

A Salesforce Lightning Web Component (`geminiChat`) that runs an LLM **fully on-device**, with no server round-trip:

1. **Primary engine:** Google's Gemini Nano via [Chrome's built-in Prompt API](https://developer.chrome.com/docs/ai/prompt-api) (stable for all websites since Chrome 148).
2. **Fallback engine:** when the Prompt API is unavailable (other browsers, older Chrome, unsupported hardware), the component can load a small open model (default `onnx-community/Qwen2.5-0.5B-Instruct`) that runs client-side via [Transformers.js](https://huggingface.co/docs/transformers.js), using WebGPU when available and WASM otherwise.

In both modes, prompts and responses never leave the user's machine.

## What it does

- Detects whether the built-in Prompt API and Gemini Nano are available on the device.
- Triggers and reports on-device model download with a progress bar.
- Offers the Transformers.js fallback model when Gemini Nano is unavailable.
- Streams responses token-by-token into a chat UI in both modes.
- Supports a configurable system prompt, plus stop and clear controls.

## Architecture

| Piece                            | Purpose                                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `lwc/geminiChat`                 | Chat UI, engine selection, Prompt API session management                                                           |
| `lwc/localLlmRunner`             | Headless service component that owns the fallback engine iframe and exposes `initialize()`, `generate()`, `stop()` |
| `staticresources/localLlmEngine` | Sandboxed iframe page that loads Transformers.js and runs the fallback model                                       |

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

Then add the **Gemini Nano Chat** component to any Lightning App/Home/Record page via the Lightning App Builder, or drop it into an Experience Cloud page.

## Notes on Lightning Web Security

The component accesses the built-in AI globals (`window.LanguageModel`, with a fallback to the legacy `window.ai.languageModel`) through `window`, which is compatible with Lightning Web Security (LWS). The Transformers.js fallback deliberately avoids the LWS sandbox entirely by running in its own iframe.

## Privacy

Both engines run inference locally in the browser. Prompts and responses are not sent to Salesforce servers, Google, or Hugging Face — the only network traffic is the one-time download of the model weights.
