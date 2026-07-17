import { LightningElement, api } from "lwc";
import LOCAL_LLM_ENGINE from "@salesforce/resourceUrl/localLlmEngine";

const NAMESPACE = "geminiChatLocalLlm";

export default class LocalLlmRunner extends LightningElement {
    engineUrl = `${LOCAL_LLM_ENGINE}/index.html`;

    _engineReady = false;
    _outbox = [];
    _requestId = 0;
    _initDeferred;
    _initTimeout;
    _initProgressed = false;
    _activeGeneration;
    _boundHandleMessage = this.handleMessage.bind(this);

    _initFailureMessage() {
        if (this._engineReady) {
            return "The local model didn't start downloading. It may be blocked by your network or by Salesforce CSP. Try the Chrome built-in Gemini Nano engine instead.";
        }
        return "Couldn't load the on-device OCR engine (Transformers.js) from the CDN, and running it needs WebAssembly. Both are blocked by Salesforce CSP by default. Use the Chrome built-in Gemini Nano engine, or add the required hosts under Setup > CSP Trusted Sites.";
    }

    connectedCallback() {
        window.addEventListener("message", this._boundHandleMessage);
    }

    disconnectedCallback() {
        window.removeEventListener("message", this._boundHandleMessage);
        if (this._initTimeout) {
            clearTimeout(this._initTimeout);
            this._initTimeout = undefined;
        }
    }

    @api
    initialize(modelId, task) {
        if (this._initDeferred) {
            return this._initDeferred.promise;
        }
        this._initDeferred = this.createDeferred();
        this._initProgressed = false;
        this.postToEngine({ type: "init", modelId, task: task || "text" });
        this._initTimeout = setTimeout(() => {
            if (this._initDeferred && !this._initProgressed) {
                this.settleInit(new Error(this._initFailureMessage()));
            }
        }, 30000);
        return this._initDeferred.promise;
    }

    settleInit(error, value) {
        if (this._initTimeout) {
            clearTimeout(this._initTimeout);
            this._initTimeout = undefined;
        }
        const deferred = this._initDeferred;
        this._initDeferred = undefined;
        if (!deferred) {
            return;
        }
        if (error) {
            deferred.reject(error);
        } else {
            deferred.resolve(value);
        }
    }

    @api
    generate(payload) {
        const body = Array.isArray(payload) ? { messages: payload } : payload;
        return this.startGeneration("generate", body);
    }

    startGeneration(type, body) {
        if (this._activeGeneration) {
            return Promise.reject(
                new Error("A generation is already in progress.")
            );
        }
        this._requestId += 1;
        const id = `req-${this._requestId}`;
        this._activeGeneration = { id, ...this.createDeferred(), text: "" };
        this.postToEngine({ type, id, ...body });
        return this._activeGeneration.promise;
    }

    @api
    stop() {
        this.postToEngine({ type: "stop" });
    }

    createDeferred() {
        const deferred = {};
        deferred.promise = new Promise((resolve, reject) => {
            deferred.resolve = resolve;
            deferred.reject = reject;
        });
        return deferred;
    }

    get iframeWindow() {
        const iframe = this.template.querySelector("iframe");
        return iframe ? iframe.contentWindow : undefined;
    }

    postToEngine(message) {
        if (!this._engineReady) {
            this._outbox.push(message);
            return;
        }
        const target = this.iframeWindow;
        if (target) {
            target.postMessage({ namespace: NAMESPACE, ...message }, "*");
        }
    }

    flushOutbox() {
        const queued = this._outbox;
        this._outbox = [];
        queued.forEach((message) => this.postToEngine(message));
    }

    handleMessage(event) {
        const data = event.data;
        if (!data || data.namespace !== NAMESPACE) {
            return;
        }
        const engineWindow = this.iframeWindow;
        if (event.source && engineWindow && event.source !== engineWindow) {
            return;
        }
        switch (data.type) {
            case "ready":
                this._engineReady = true;
                this.flushOutbox();
                break;
            case "progress":
                this._initProgressed = true;
                this.dispatchEvent(
                    new CustomEvent("progress", {
                        detail: { loaded: data.loaded }
                    })
                );
                break;
            case "initialized":
                this.settleInit(undefined, { device: data.device });
                break;
            case "status":
                this.dispatchEvent(
                    new CustomEvent("status", {
                        detail: { message: data.message }
                    })
                );
                break;
            case "reset":
                if (
                    this._activeGeneration &&
                    this._activeGeneration.id === data.id
                ) {
                    this._activeGeneration.text = "";
                    this.dispatchEvent(
                        new CustomEvent("chunk", {
                            detail: { text: "", fullText: "" }
                        })
                    );
                }
                break;
            case "chunk":
                this.handleChunk(data);
                break;
            case "done":
                this.handleDone(data);
                break;
            case "error":
                this.handleError(data);
                break;
            default:
                break;
        }
    }

    handleChunk(data) {
        const generation = this._activeGeneration;
        if (!generation || generation.id !== data.id) {
            return;
        }
        generation.text += data.text;
        this.dispatchEvent(
            new CustomEvent("chunk", {
                detail: { text: data.text, fullText: generation.text }
            })
        );
    }

    handleDone(data) {
        const generation = this._activeGeneration;
        if (!generation || generation.id !== data.id) {
            return;
        }
        this._activeGeneration = undefined;
        generation.resolve(generation.text);
    }

    handleError(data) {
        const error = new Error(data.message || "Local model error.");
        if (data.id) {
            const generation = this._activeGeneration;
            if (generation && generation.id === data.id) {
                this._activeGeneration = undefined;
                generation.reject(error);
            }
            return;
        }
        if (this._initDeferred) {
            this.settleInit(error);
        }
        if (this._activeGeneration) {
            this._activeGeneration.reject(error);
            this._activeGeneration = undefined;
        }
    }
}
