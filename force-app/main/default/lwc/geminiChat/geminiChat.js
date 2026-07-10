import { LightningElement, api, track } from "lwc";

const STATUS = {
    UNSUPPORTED: "unsupported",
    UNAVAILABLE: "unavailable",
    DOWNLOADABLE: "downloadable",
    DOWNLOADING: "downloading",
    AVAILABLE: "available",
    CHECKING: "checking"
};

const FALLBACK = {
    NONE: "none",
    LOADING: "loading",
    READY: "ready",
    FAILED: "failed"
};

const DEFAULT_SYSTEM_PROMPT =
    "You are a helpful assistant embedded inside a Salesforce Lightning Web Component. Keep answers concise and relevant.";

export default class GeminiChat extends LightningElement {
    @api fallbackModelId = "onnx-community/Qwen2.5-0.5B-Instruct";

    @track messages = [];
    @track availability = STATUS.CHECKING;
    fallbackState = FALLBACK.NONE;
    fallbackDevice = "";
    downloadProgress = 0;
    prompt = "";
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
    isGenerating = false;
    errorMessage = "";

    _session;
    _abortController;
    _messageId = 0;
    _fallbackInitStarted = false;
    _streamingMessageId;

    connectedCallback() {
        this.detectAvailability();
    }

    renderedCallback() {
        if (
            this.fallbackState === FALLBACK.LOADING &&
            !this._fallbackInitStarted
        ) {
            this._fallbackInitStarted = true;
            this.initializeFallback();
        }
    }

    disconnectedCallback() {
        this.destroySession();
    }

    get languageModel() {
        if (typeof window === "undefined") {
            return undefined;
        }
        if (window.LanguageModel) {
            return window.LanguageModel;
        }
        if (window.ai && window.ai.languageModel) {
            return window.ai.languageModel;
        }
        return undefined;
    }

    get fallbackRunner() {
        return this.template.querySelector("c-local-llm-runner");
    }

    get usesFallback() {
        return this.fallbackState !== FALLBACK.NONE;
    }

    get isFallbackActive() {
        return this.fallbackState === FALLBACK.READY;
    }

    get isFallbackLoading() {
        return this.fallbackState === FALLBACK.LOADING;
    }

    get isReady() {
        return this.availability === STATUS.AVAILABLE || this.isFallbackActive;
    }

    get isDownloading() {
        return (
            this.availability === STATUS.DOWNLOADING || this.isFallbackLoading
        );
    }

    get isChecking() {
        return this.availability === STATUS.CHECKING;
    }

    get needsDownload() {
        return this.availability === STATUS.DOWNLOADABLE;
    }

    get promptApiUnavailable() {
        return (
            this.availability === STATUS.UNAVAILABLE ||
            this.availability === STATUS.UNSUPPORTED
        );
    }

    get showFallbackOffer() {
        return (
            this.promptApiUnavailable &&
            (this.fallbackState === FALLBACK.NONE ||
                this.fallbackState === FALLBACK.FAILED)
        );
    }

    get hasMessages() {
        return this.messages.length > 0;
    }

    get sendDisabled() {
        return (
            this.isGenerating ||
            !this.isReady ||
            !this.prompt ||
            this.prompt.trim().length === 0
        );
    }

    get downloadPercent() {
        return Math.round(this.downloadProgress * 100);
    }

    get statusLabel() {
        if (this.isFallbackActive) {
            const device = this.fallbackDevice === "webgpu" ? "WebGPU" : "WASM";
            return `Fallback model is running locally in your browser (${device}).`;
        }
        if (this.isFallbackLoading) {
            return `Downloading fallback model (${this.downloadPercent}%)...`;
        }
        switch (this.availability) {
            case STATUS.AVAILABLE:
                return "Gemini Nano is ready on this device.";
            case STATUS.DOWNLOADABLE:
                return "Gemini Nano can be downloaded to this device.";
            case STATUS.DOWNLOADING:
                return `Downloading Gemini Nano (${this.downloadPercent}%)...`;
            case STATUS.CHECKING:
                return "Checking on-device model availability...";
            case STATUS.UNSUPPORTED:
                return "This browser does not expose the Chrome built-in Prompt API.";
            default:
                return "Gemini Nano is not available on this device.";
        }
    }

    async detectAvailability() {
        this.errorMessage = "";
        const model = this.languageModel;
        if (!model) {
            this.availability = STATUS.UNSUPPORTED;
            return;
        }
        this.availability = STATUS.CHECKING;
        try {
            const result = await model.availability();
            this.availability = this.normalizeAvailability(result);
        } catch (error) {
            this.availability = STATUS.UNAVAILABLE;
            this.errorMessage = this.readableError(error);
        }
    }

    normalizeAvailability(result) {
        switch (result) {
            case "readily":
            case "available":
                return STATUS.AVAILABLE;
            case "after-download":
            case "downloadable":
                return STATUS.DOWNLOADABLE;
            case "downloading":
                return STATUS.DOWNLOADING;
            default:
                return STATUS.UNAVAILABLE;
        }
    }

    handlePromptChange(event) {
        this.prompt = event.target.value;
    }

    handleSystemPromptChange(event) {
        this.systemPrompt = event.target.value;
    }

    handleKeyDown(event) {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            this.handleSend();
        }
    }

    async handleDownload() {
        try {
            await this.ensureSession();
        } catch (error) {
            this.errorMessage = this.readableError(error);
        }
    }

    handleLoadFallback() {
        this.errorMessage = "";
        this.downloadProgress = 0;
        this._fallbackInitStarted = false;
        this.fallbackState = FALLBACK.LOADING;
    }

    async initializeFallback() {
        try {
            const result = await this.fallbackRunner.initialize(
                this.fallbackModelId
            );
            this.fallbackDevice = result.device;
            this.downloadProgress = 1;
            this.fallbackState = FALLBACK.READY;
        } catch (error) {
            this.fallbackState = FALLBACK.FAILED;
            this.errorMessage = this.readableError(error);
        }
    }

    handleFallbackProgress(event) {
        this.downloadProgress = event.detail.loaded;
    }

    handleFallbackChunk(event) {
        if (this._streamingMessageId) {
            this.updateMessage(this._streamingMessageId, event.detail.fullText);
        }
    }

    async ensureSession() {
        if (this._session) {
            return this._session;
        }
        const model = this.languageModel;
        if (!model) {
            throw new Error("The Chrome built-in Prompt API is not available.");
        }
        const options = {
            monitor: (monitor) => {
                monitor.addEventListener("downloadprogress", (event) => {
                    this.availability = STATUS.DOWNLOADING;
                    this.downloadProgress = event.loaded;
                });
            }
        };
        if (this.systemPrompt && this.systemPrompt.trim().length > 0) {
            options.initialPrompts = [
                { role: "system", content: this.systemPrompt.trim() }
            ];
        }
        this._session = await model.create(options);
        this.availability = STATUS.AVAILABLE;
        this.downloadProgress = 1;
        return this._session;
    }

    async handleSend() {
        if (this.sendDisabled) {
            return;
        }
        const userText = this.prompt.trim();
        this.prompt = "";
        this.errorMessage = "";
        this.appendMessage("user", userText);
        const assistantMessage = this.appendMessage("assistant", "");
        this._streamingMessageId = assistantMessage.id;
        this.isGenerating = true;
        try {
            if (this.isFallbackActive) {
                await this.sendViaFallback();
            } else {
                await this.sendViaPromptApi(userText, assistantMessage.id);
            }
        } catch (error) {
            if (error && error.name === "AbortError") {
                this.updateMessage(
                    assistantMessage.id,
                    this.getMessageText(assistantMessage.id) + " [stopped]"
                );
            } else {
                this.errorMessage = this.readableError(error);
                this.removeMessage(assistantMessage.id);
            }
        } finally {
            this.isGenerating = false;
            this._abortController = undefined;
            this._streamingMessageId = undefined;
        }
    }

    async sendViaPromptApi(userText, messageId) {
        this._abortController = new AbortController();
        const session = await this.ensureSession();
        const stream = session.promptStreaming(userText, {
            signal: this._abortController.signal
        });
        let full = "";
        for await (const chunk of stream) {
            full += chunk;
            this.updateMessage(messageId, full);
        }
    }

    async sendViaFallback() {
        const chatMessages = this.buildChatMessages();
        await this.fallbackRunner.generate(chatMessages);
    }

    buildChatMessages() {
        const chatMessages = [];
        if (this.systemPrompt && this.systemPrompt.trim().length > 0) {
            chatMessages.push({
                role: "system",
                content: this.systemPrompt.trim()
            });
        }
        this.messages.forEach((message) => {
            if (message.id !== this._streamingMessageId) {
                chatMessages.push({
                    role: message.role,
                    content: message.text
                });
            }
        });
        return chatMessages;
    }

    handleStop() {
        if (this._abortController) {
            this._abortController.abort();
        }
        if (this.isFallbackActive && this.fallbackRunner) {
            this.fallbackRunner.stop();
        }
    }

    handleClear() {
        this.messages = [];
        this.errorMessage = "";
        this.destroySession();
    }

    destroySession() {
        if (this._session && typeof this._session.destroy === "function") {
            this._session.destroy();
        }
        this._session = undefined;
    }

    appendMessage(role, text) {
        this._messageId += 1;
        const message = {
            id: `msg-${this._messageId}`,
            role,
            text,
            cssClass:
                role === "user"
                    ? "gemini-message gemini-message_user"
                    : "gemini-message gemini-message_assistant"
        };
        this.messages = [...this.messages, message];
        return message;
    }

    updateMessage(id, text) {
        this.messages = this.messages.map((message) => {
            return message.id === id ? { ...message, text } : message;
        });
    }

    getMessageText(id) {
        const found = this.messages.find((message) => message.id === id);
        return found ? found.text : "";
    }

    removeMessage(id) {
        this.messages = this.messages.filter((message) => message.id !== id);
    }

    readableError(error) {
        if (!error) {
            return "An unknown error occurred.";
        }
        if (typeof error === "string") {
            return error;
        }
        return error.message || String(error);
    }
}
