import { getOcrPrompt } from "c/ocrPrompts";
import { preprocessImageBlob, downscaleImageBlob } from "c/imagePreprocessor";

export default class OcrProcessor {
    constructor({ languageModel } = {}) {
        this._languageModel =
            languageModel ||
            (typeof window !== "undefined" ? window.LanguageModel : undefined);
        this._session = undefined;
    }

    get isSupported() {
        return Boolean(this._languageModel);
    }

    availability() {
        if (!this._languageModel) {
            return Promise.resolve("unavailable");
        }
        return this._languageModel.availability({
            expectedInputs: [{ type: "image" }]
        });
    }

    async ensureSession() {
        if (this._session) {
            return this._session;
        }
        if (!this._languageModel) {
            throw new Error(
                "The Chrome built-in Prompt API is not available in this browser."
            );
        }
        this._session = await this._languageModel.create({
            expectedInputs: [{ type: "image" }]
        });
        return this._session;
    }

    async processImage(image, options = {}) {
        const {
            formatType = "markdown",
            preprocess = true,
            customPrompt = "",
            language = "en",
            signal,
            onChunk
        } = options;
        const input = preprocess
            ? await preprocessImageBlob(image, language)
            : await downscaleImageBlob(image);
        const prompt = getOcrPrompt(formatType, language, customPrompt);
        try {
            const result = await this.runPrompt(input, prompt, signal, onChunk);
            return formatResult(result, formatType);
        } catch (error) {
            if (error && error.name === "AbortError") {
                throw error;
            }
            this.destroy();
            if (isModelCrash(error)) {
                throw new Error(
                    "Chrome's built-in Gemini Nano has disabled itself after repeated crashes on this device. Fully quit and reopen Chrome to reset it, close other GPU-heavy tabs, or switch to the Local model engine."
                );
            }
            const smaller = await downscaleImageBlob(input, 768);
            try {
                const result = await this.runPrompt(
                    smaller,
                    prompt,
                    signal,
                    onChunk
                );
                return formatResult(result, formatType);
            } catch (retryError) {
                if (retryError && retryError.name === "AbortError") {
                    throw retryError;
                }
                if (isModelCrash(retryError)) {
                    throw new Error(
                        "Chrome's built-in Gemini Nano has disabled itself after repeated crashes on this device. Fully quit and reopen Chrome to reset it, close other GPU-heavy tabs, or switch to the Local model engine."
                    );
                }
                throw new Error(
                    `Gemini Nano could not read this image (${retryError.message || retryError}). Try a smaller or clearer image, or switch to the Local model engine.`
                );
            }
        }
    }

    async runPrompt(input, prompt, signal, onChunk) {
        const session = await this.ensureSession();
        const stream = session.promptStreaming(
            [
                {
                    role: "user",
                    content: [
                        { type: "image", value: input },
                        { type: "text", value: prompt }
                    ]
                }
            ],
            { signal }
        );
        let result = "";
        for await (const chunk of stream) {
            result += chunk;
            if (onChunk) {
                onChunk(result);
            }
        }
        return result;
    }

    async processBatch(images, options = {}) {
        const results = {};
        const errors = {};
        const files = [...images];
        for (const file of files) {
            const name = file.name || `image-${Object.keys(results).length}`;
            try {
                results[name] = await this.processImage(file, {
                    ...options,
                    onChunk: options.onChunk
                        ? (text) => options.onChunk(file, text)
                        : undefined
                });
            } catch (error) {
                if (error && error.name === "AbortError") {
                    throw error;
                }
                errors[name] = error.message || String(error);
            }
        }
        return {
            results,
            errors,
            statistics: {
                total: files.length,
                successful: Object.keys(results).length,
                failed: Object.keys(errors).length
            }
        };
    }

    destroy() {
        if (this._session && typeof this._session.destroy === "function") {
            this._session.destroy();
        }
        this._session = undefined;
    }
}

function isModelCrash(error) {
    const message = String((error && error.message) || error || "").toLowerCase();
    return (
        message.includes("crashed") ||
        message.includes("process crash") ||
        message.includes("too many times")
    );
}

function formatResult(result, formatType) {
    if (formatType !== "json") {
        return result;
    }
    try {
        return JSON.stringify(JSON.parse(result), null, 2);
    } catch (ignored) {
        return result;
    }
}

export { formatResult };
