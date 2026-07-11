import { LightningElement, api, track } from "lwc";
import { getOcrPrompt, FORMAT_OPTIONS } from "c/ocrPrompts";

const ENGINE = {
    AUTO: "auto",
    GEMINI: "gemini",
    LOCAL: "local",
    OLLAMA: "ollama"
};

const ENGINE_OPTIONS = [
    { label: "Auto (prefer built-in Gemini Nano)", value: ENGINE.AUTO },
    { label: "Chrome built-in Gemini Nano", value: ENGINE.GEMINI },
    { label: "Local model (Transformers.js)", value: ENGINE.LOCAL },
    { label: "Ollama server", value: ENGINE.OLLAMA }
];

export default class VisionOcr extends LightningElement {
    @api fallbackModelId = "HuggingFaceTB/SmolVLM-256M-Instruct";
    @api ollamaEndpoint = "http://localhost:11434";
    @api ollamaModel = "llama3.2-vision:11b";

    @track imagePreviewUrl;
    _ollamaEndpointOverride;
    _ollamaModelOverride;
    engine = ENGINE.AUTO;
    formatType = "markdown";
    language = "en";
    customPrompt = "";
    result = "";
    errorMessage = "";
    isProcessing = false;
    isModelLoading = false;
    downloadProgress = 0;
    geminiAvailability = "checking";
    localModelReady = false;

    _imageFile;
    _imageDataUrl;
    _session;
    _abortController;

    connectedCallback() {
        this.detectGeminiAvailability();
    }

    disconnectedCallback() {
        this.destroySession();
    }

    get languageModel() {
        if (typeof window === "undefined") {
            return undefined;
        }
        return window.LanguageModel;
    }

    get engineOptions() {
        return ENGINE_OPTIONS;
    }

    get formatOptions() {
        return FORMAT_OPTIONS;
    }

    get isCustomFormat() {
        return this.formatType === "custom";
    }

    get geminiUsable() {
        return (
            this.geminiAvailability === "available" ||
            this.geminiAvailability === "downloadable" ||
            this.geminiAvailability === "downloading"
        );
    }

    get resolvedEngine() {
        if (this.engine === ENGINE.AUTO) {
            return this.geminiUsable ? ENGINE.GEMINI : ENGINE.LOCAL;
        }
        return this.engine;
    }

    get usesRunner() {
        return (
            this.resolvedEngine === ENGINE.LOCAL ||
            this.resolvedEngine === ENGINE.OLLAMA
        );
    }

    get isOllamaEngine() {
        return this.resolvedEngine === ENGINE.OLLAMA;
    }

    get hasImage() {
        return Boolean(this._imageDataUrl);
    }

    get hasResult() {
        return this.result && this.result.length > 0;
    }

    get runDisabled() {
        return this.isProcessing || this.isModelLoading || !this.hasImage;
    }

    get downloadPercent() {
        return Math.round(this.downloadProgress * 100);
    }

    get statusLabel() {
        if (this.isModelLoading) {
            return `Downloading vision model (${this.downloadPercent}%)...`;
        }
        switch (this.resolvedEngine) {
            case ENGINE.GEMINI:
                return this.geminiUsable
                    ? "Using Chrome's built-in Gemini Nano (on-device)."
                    : "Gemini Nano is not available in this browser. Pick another engine.";
            case ENGINE.OLLAMA:
                return `Using Ollama at ${this.currentOllamaEndpoint} (${this.currentOllamaModel}).`;
            default:
                return this.localModelReady
                    ? "Local vision model is ready (runs in your browser)."
                    : "Local vision model will download on first run.";
        }
    }

    async detectGeminiAvailability() {
        const model = this.languageModel;
        if (!model) {
            this.geminiAvailability = "unsupported";
            return;
        }
        try {
            const result = await model.availability({
                expectedInputs: [{ type: "image" }]
            });
            this.geminiAvailability = result;
        } catch (ignored) {
            this.geminiAvailability = "unavailable";
        }
    }

    handleEngineChange(event) {
        this.engine = event.detail.value;
        this.errorMessage = "";
    }

    handleFormatChange(event) {
        this.formatType = event.detail.value;
    }

    handleLanguageChange(event) {
        this.language = event.target.value;
    }

    handleCustomPromptChange(event) {
        this.customPrompt = event.target.value;
    }

    get currentOllamaEndpoint() {
        return this._ollamaEndpointOverride || this.ollamaEndpoint;
    }

    get currentOllamaModel() {
        return this._ollamaModelOverride || this.ollamaModel;
    }

    handleOllamaEndpointChange(event) {
        this._ollamaEndpointOverride = event.target.value;
    }

    handleOllamaModelChange(event) {
        this._ollamaModelOverride = event.target.value;
    }

    handleFileChange(event) {
        const file = event.target.files && event.target.files[0];
        if (!file) {
            return;
        }
        this.errorMessage = "";
        this.result = "";
        this._imageFile = file;
        const reader = new FileReader();
        reader.onload = () => {
            this._imageDataUrl = reader.result;
            this.imagePreviewUrl = reader.result;
        };
        reader.onerror = () => {
            this.errorMessage = "Could not read the selected file.";
        };
        reader.readAsDataURL(file);
    }

    get ocrPrompt() {
        return getOcrPrompt(
            this.formatType,
            this.language || "en",
            this.isCustomFormat ? this.customPrompt : ""
        );
    }

    get imageBase64() {
        const dataUrl = this._imageDataUrl || "";
        const commaIndex = dataUrl.indexOf(",");
        return commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
    }

    async handleRun() {
        if (this.runDisabled) {
            return;
        }
        this.errorMessage = "";
        this.result = "";
        this.isProcessing = true;
        try {
            const engine = this.resolvedEngine;
            if (engine === ENGINE.GEMINI) {
                await this.runWithGemini();
            } else if (engine === ENGINE.OLLAMA) {
                await this.runWithOllama();
            } else {
                await this.runWithLocalModel();
            }
            this.postProcessResult();
        } catch (error) {
            if (!error || error.name !== "AbortError") {
                this.errorMessage = this.readableError(error);
            }
        } finally {
            this.isProcessing = false;
            this._abortController = undefined;
        }
    }

    async runWithGemini() {
        const model = this.languageModel;
        if (!model) {
            throw new Error(
                "The Chrome built-in Prompt API is not available in this browser."
            );
        }
        if (!this._session) {
            this._session = await model.create({
                expectedInputs: [{ type: "image" }]
            });
        }
        this._abortController = new AbortController();
        const stream = this._session.promptStreaming(
            [
                {
                    role: "user",
                    content: [
                        { type: "image", value: this._imageFile },
                        { type: "text", value: this.ocrPrompt }
                    ]
                }
            ],
            { signal: this._abortController.signal }
        );
        for await (const chunk of stream) {
            this.result += chunk;
        }
    }

    async runWithLocalModel() {
        const runner = this.template.querySelector("c-local-llm-runner");
        if (!this.localModelReady) {
            this.isModelLoading = true;
            this.downloadProgress = 0;
            try {
                await runner.initialize(this.fallbackModelId, "vision");
                this.localModelReady = true;
            } finally {
                this.isModelLoading = false;
            }
        }
        await runner.generate({
            prompt: this.ocrPrompt,
            image: this._imageDataUrl
        });
    }

    async runWithOllama() {
        const runner = this.template.querySelector("c-local-llm-runner");
        await runner.ollamaGenerate({
            endpoint: this.currentOllamaEndpoint,
            model: this.currentOllamaModel,
            prompt: this.ocrPrompt,
            imageBase64: this.imageBase64
        });
    }

    handleRunnerProgress(event) {
        this.downloadProgress = event.detail.loaded;
    }

    handleRunnerChunk(event) {
        this.result = event.detail.fullText;
    }

    handleStop() {
        if (this._abortController) {
            this._abortController.abort();
        }
        const runner = this.template.querySelector("c-local-llm-runner");
        if (runner) {
            runner.stop();
        }
    }

    async handleCopy() {
        try {
            await navigator.clipboard.writeText(this.result);
        } catch (ignored) {
            this.errorMessage = "Could not copy to clipboard.";
        }
    }

    postProcessResult() {
        if (this.formatType !== "json" || !this.result) {
            return;
        }
        try {
            this.result = JSON.stringify(JSON.parse(this.result), null, 2);
        } catch (ignored) {
            // leave the raw model output when it is not valid JSON
        }
    }

    destroySession() {
        if (this._session && typeof this._session.destroy === "function") {
            this._session.destroy();
        }
        this._session = undefined;
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
