# Chrome Gemini Nano LWC

A Salesforce Lightning Web Component (`geminiChat`) that runs Google's **Gemini Nano** model **fully on-device** using [Chrome's built-in AI Prompt API](https://developer.chrome.com/docs/ai/prompt-api). No data leaves the browser and no external LLM API is called — inference happens locally in Chrome.

## What it does

- Detects whether the built-in Prompt API and Gemini Nano are available on the device.
- Triggers and reports on-device model download with a progress bar.
- Streams responses token-by-token into a chat UI.
- Supports a configurable system prompt, `temperature`, and `topK`.
- Lets you stop an in-flight generation and clear the conversation.

## Component

| Item         | Value                                                    |
| ------------ | -------------------------------------------------------- |
| Bundle       | `force-app/main/default/lwc/geminiChat`                  |
| Master label | `Gemini Nano Chat`                                       |
| Targets      | App Page, Home Page, Record Page, Experience Cloud pages |

## Requirements (client / browser)

The component relies on capabilities that only exist in Chrome desktop:

1. A supported Chrome build (Chrome 138+ recommended) on desktop with sufficient hardware (≈22 GB free disk, >4 GB VRAM).
2. Enable the flags, then restart Chrome:
    - `chrome://flags/#prompt-api-for-gemini-nano` → **Enabled**
    - `chrome://flags/#optimization-guide-on-device-model` → **Enabled BypassPerfRequirement**
3. Let Gemini Nano finish downloading (visible under `chrome://components` → _Optimization Guide On Device Model_).

The component checks `window.LanguageModel` first and falls back to the legacy `window.ai.languageModel` namespace, so it works across recent API iterations.

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

Then add the **Gemini Nano Chat** component to any Lightning App/Home/Record page via the Lightning App Builder, or drop it into an Experience Cloud page. Open the page in a properly configured Chrome browser.

## Notes on Lightning Web Security

The component accesses the built-in AI globals through `window`, which is compatible with Lightning Web Security (LWS). If your org still uses the legacy Locker Service, verify that `window.LanguageModel` / `window.ai` are reachable; LWS is recommended.

## Privacy

Because inference runs against the locally downloaded Gemini Nano model, prompts and responses stay on the user's machine. Nothing is sent to Salesforce servers or to Google during a prompt.
