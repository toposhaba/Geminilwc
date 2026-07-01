import { LightningElement, track } from "lwc";

const STATUS = {
    UNSUPPORTED: "unsupported",
    UNAVAILABLE: "unavailable",
    DOWNLOADABLE: "downloadable",
    DOWNLOADING: "downloading",
    AVAILABLE: "available",
    CHECKING: "checking"
};

const DEFAULT_SYSTEM_PROMPT =
    "You are a helpful assistant embedded inside a Salesforce Lightning Web Component. Keep answers concise and relevant.";

export default class GeminiChat extends LightningElement {
    @track messages = [];
    @track availability = STATUS.CHECKING;
    downloadProgress = 0;
    prompt = "";
    systemPrompt = DEFAULT_SYSTEM_PROMPT;
    temperature = 1;
    topK = 3;
    isGenerating = false;
    errorMessage = "";

    _session;
    _abortController;
    _messageId = 0;

    connectedCallback() {
        this.detectAvailability();
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

    get isSupported() {
        return this.languageModel !== undefined;
    }

    get isReady() {
        return this.availability === STATUS.AVAILABLE;
    }

    get isDownloading() {
        return this.availability === STATUS.DOWNLOADING;
    }

    get isChecking() {
        return this.availability === STATUS.CHECKING;
    }

    get needsDownload() {
        return this.availability === STATUS.DOWNLOADABLE;
    }

    get isUnavailable() {
        return (
            this.availability === STATUS.UNAVAILABLE ||
            this.availability === STATUS.UNSUPPORTED
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

    handleTemperatureChange(event) {
        this.temperature = Number(event.target.value);
    }

    handleTopKChange(event) {
        this.topK = Number(event.target.value);
    }

    handleKeyDown(event) {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            this.handleSend();
        }
    }

    async handleDownload() {
        await this.ensureSession();
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
            temperature: this.temperature,
            topK: this.topK,
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
        this.isGenerating = true;
        this._abortController = new AbortController();
        try {
            const session = await this.ensureSession();
            const stream = session.promptStreaming(userText, {
                signal: this._abortController.signal
            });
            await this.consumeStream(stream, assistantMessage.id);
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
        }
    }

    async consumeStream(stream, messageId) {
        let full = "";
        let previous = "";
        for await (const chunk of stream) {
            if (chunk.startsWith(previous) && previous.length > 0) {
                full = chunk;
            } else {
                full += chunk;
            }
            previous = chunk;
            this.updateMessage(messageId, full);
        }
    }

    handleStop() {
        if (this._abortController) {
            this._abortController.abort();
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
