import { LightningElement, api, track } from "lwc";
import { getOcrPrompt, FORMAT_OPTIONS, LANGUAGE_OPTIONS } from "c/ocrPrompts";
import {
    preprocessImageBlob,
    detectDocumentLikeBlob
} from "c/imagePreprocessor";

const PREPROCESS_OPTIONS = [
    { label: "Auto (detect scanned documents)", value: "auto" },
    { label: "Always binarize (scanned documents)", value: "on" },
    { label: "Never binarize (photos and color images)", value: "off" }
];
import OcrProcessor, { formatResult } from "c/ocrProcessor";

const ENGINE = {
    AUTO: "auto",
    GEMINI: "gemini",
    LOCAL: "local"
};

const ENGINE_OPTIONS = [
    { label: "Auto (prefer built-in Gemini Nano)", value: ENGINE.AUTO },
    { label: "Chrome built-in Gemini Nano", value: ENGINE.GEMINI },
    { label: "Local model (Transformers.js)", value: ENGINE.LOCAL }
];

export default class VisionOcr extends LightningElement {
    @api fallbackModelId = "HuggingFaceTB/SmolVLM-500M-Instruct";

    @track imagePreviewUrl;
    @track fileResults = [];
    engine = ENGINE.AUTO;
    formatType = "markdown";
    language = "English";
    customPrompt = "";
    preprocessMode = "auto";
    autoDetectNote = "";
    errorMessage = "";
    runnerStatus = "";
    isProcessing = false;
    isModelLoading = false;
    downloadProgress = 0;
    geminiAvailability = "checking";
    localModelReady = false;

    _files = [];
    _processor;
    _abortController;
    _currentIndex = -1;

    connectedCallback() {
        this.detectGeminiAvailability();
    }

    disconnectedCallback() {
        if (this._processor) {
            this._processor.destroy();
        }
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

    get languageOptions() {
        return LANGUAGE_OPTIONS;
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
        return this.resolvedEngine === ENGINE.LOCAL;
    }

    get hasImage() {
        return this._files.length > 0;
    }

    get isBatch() {
        return this._files.length > 1;
    }

    get fileCountLabel() {
        return `${this._files.length} images selected`;
    }

    get hasResults() {
        return this.fileResults.some((entry) => entry.text || entry.error);
    }

    get statistics() {
        const total = this.fileResults.length;
        const failed = this.fileResults.filter((entry) => entry.error).length;
        const successful = this.fileResults.filter(
            (entry) => entry.done && !entry.error
        ).length;
        return `${successful} succeeded, ${failed} failed, ${total} total`;
    }

    get showStatistics() {
        return !this.isProcessing && this.isBatch && this.hasResults;
    }

    get runDisabled() {
        return this.isProcessing || this.isModelLoading || !this.hasImage;
    }

    get downloadPercent() {
        return Math.round(this.downloadProgress * 100);
    }

    get statusLabel() {
        if (this.runnerStatus) {
            return this.runnerStatus;
        }
        if (this.isModelLoading) {
            return `Downloading vision model (${this.downloadPercent}%)...`;
        }
        switch (this.resolvedEngine) {
            case ENGINE.GEMINI:
                return this.geminiUsable
                    ? "Using Chrome's built-in Gemini Nano (on-device)."
                    : "Gemini Nano is not available in this browser. Pick another engine.";
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
        this.language = event.detail.value;
    }

    handleCustomPromptChange(event) {
        this.customPrompt = event.target.value;
    }

    handlePreprocessChange(event) {
        this.preprocessMode = event.detail.value;
        this.autoDetectNote = "";
    }

    get preprocessOptions() {
        return PREPROCESS_OPTIONS;
    }

    async resolvePreprocess(file) {
        if (this.preprocessMode === "on") {
            return true;
        }
        if (this.preprocessMode === "off") {
            return false;
        }
        try {
            const { isDocument } = await detectDocumentLikeBlob(file);
            this.autoDetectNote = isDocument
                ? "Auto-detected a scanned document: binarizing."
                : "Auto-detected a photo/color image: using the original.";
            return isDocument;
        } catch (ignored) {
            return false;
        }
    }

    handleFileChange(event) {
        const files = event.target.files ? [...event.target.files] : [];
        if (files.length === 0) {
            return;
        }
        this.errorMessage = "";
        this.fileResults = [];
        this._files = files;
        this.imagePreviewUrl = undefined;
        const reader = new FileReader();
        reader.onload = () => {
            this.imagePreviewUrl = reader.result;
        };
        reader.readAsDataURL(files[0]);
    }

    get ocrPrompt() {
        return getOcrPrompt(
            this.formatType,
            this.language || "English",
            this.isCustomFormat ? this.customPrompt : ""
        );
    }

    async handleRun() {
        if (this.runDisabled) {
            return;
        }
        this.errorMessage = "";
        this.runnerStatus = "";
        this.isProcessing = true;
        this._abortController = new AbortController();
        this.fileResults = this._files.map((file) => ({
            name: file.name,
            text: "",
            error: "",
            done: false
        }));
        try {
            const engine = this.resolvedEngine;
            for (let index = 0; index < this._files.length; index++) {
                if (this._abortController.signal.aborted) {
                    break;
                }
                this._currentIndex = index;
                try {
                    if (engine === ENGINE.GEMINI) {
                        await this.processWithGemini(this._files[index], index);
                    } else {
                        await this.processWithLocalModel(
                            this._files[index],
                            index
                        );
                    }
                    this.patchFileResult(index, { done: true });
                } catch (error) {
                    if (error && error.name === "AbortError") {
                        this.patchFileResult(index, { done: true });
                        break;
                    }
                    this.patchFileResult(index, {
                        error: this.readableError(error),
                        done: true
                    });
                }
            }
        } finally {
            this.isProcessing = false;
            this._abortController = undefined;
            this._currentIndex = -1;
        }
    }

    async processWithGemini(file, index) {
        if (!this._processor) {
            this._processor = new OcrProcessor({
                languageModel: this.languageModel
            });
        }
        const text = await this._processor.processImage(file, {
            formatType: this.formatType,
            preprocess: await this.resolvePreprocess(file),
            customPrompt: this.isCustomFormat ? this.customPrompt : "",
            language: this.language || "English",
            signal: this._abortController.signal,
            onChunk: (partial) => this.patchFileResult(index, { text: partial })
        });
        this.patchFileResult(index, { text });
    }

    async processWithLocalModel(file, index) {
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
        const dataUrl = await this.toDataUrl(await this.maybePreprocess(file));
        const text = await runner.generate({
            prompt: this.ocrPrompt,
            image: dataUrl
        });
        this.patchFileResult(index, {
            text: formatResult(text, this.formatType)
        });
    }

    async maybePreprocess(file) {
        const shouldPreprocess = await this.resolvePreprocess(file);
        if (!shouldPreprocess) {
            return file;
        }
        return preprocessImageBlob(file, this.language || "English");
    }

    toDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () =>
                reject(new Error("Could not read the selected file."));
            reader.readAsDataURL(blob);
        });
    }

    patchFileResult(index, patch) {
        this.fileResults = this.fileResults.map((entry, entryIndex) => {
            return entryIndex === index ? { ...entry, ...patch } : entry;
        });
    }

    handleRunnerProgress(event) {
        this.downloadProgress = event.detail.loaded;
    }

    handleRunnerStatus(event) {
        this.runnerStatus = event.detail.message;
    }

    handleRunnerChunk(event) {
        if (this._currentIndex >= 0) {
            this.patchFileResult(this._currentIndex, {
                text: event.detail.fullText
            });
        }
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
        const combined = this.fileResults
            .filter((entry) => entry.text)
            .map((entry) => {
                return this.isBatch
                    ? `${entry.name}:\n${entry.text}`
                    : entry.text;
            })
            .join("\n\n");
        try {
            await navigator.clipboard.writeText(combined);
        } catch (ignored) {
            this.errorMessage = "Could not copy to clipboard.";
        }
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
