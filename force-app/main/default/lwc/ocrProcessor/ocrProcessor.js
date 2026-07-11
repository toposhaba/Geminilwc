import { getOcrPrompt } from "c/ocrPrompts";
import { preprocessImageBlob } from "c/imagePreprocessor";

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
            : image;
        const prompt = getOcrPrompt(formatType, language, customPrompt);
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
        return formatResult(result, formatType);
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
