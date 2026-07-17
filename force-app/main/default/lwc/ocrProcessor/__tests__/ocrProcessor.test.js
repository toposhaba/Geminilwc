import OcrProcessor, { formatResult } from "c/ocrProcessor";
import { preprocessImageBlob } from "c/imagePreprocessor";

jest.mock("c/imagePreprocessor", () => ({
    preprocessImageBlob: jest.fn((blob) => Promise.resolve(blob))
}));

function createStreamFromChunks(chunks) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
                yield chunk;
            }
        }
    };
}

function createModel(session) {
    return {
        availability: jest.fn().mockResolvedValue("available"),
        create: jest.fn().mockResolvedValue(session)
    };
}

describe("c-ocr-processor", () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it("streams a result and reports partial text", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(["Hello ", "world"]))
        };
        const model = createModel(session);
        const processor = new OcrProcessor({ languageModel: model });
        const partials = [];
        const file = { name: "doc.png" };

        const result = await processor.processImage(file, {
            preprocess: false,
            onChunk: (text) => partials.push(text)
        });

        expect(result).toBe("Hello world");
        expect(partials).toEqual(["Hello ", "Hello world"]);
        expect(model.create).toHaveBeenCalledWith({
            expectedInputs: [{ type: "image" }]
        });
        const promptArg = session.promptStreaming.mock.calls[0][0];
        expect(promptArg[0].content[0]).toEqual({
            type: "image",
            value: file
        });
        expect(promptArg[0].content[1].value).toContain("markdown");
        expect(preprocessImageBlob).not.toHaveBeenCalled();
    });

    it("preprocesses the image before prompting when enabled", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(["ok"]))
        };
        const processor = new OcrProcessor({
            languageModel: createModel(session)
        });
        const file = { name: "doc.png" };

        await processor.processImage(file, { language: "en" });

        expect(preprocessImageBlob).toHaveBeenCalledWith(file, "en");
    });

    it("uses the custom prompt when provided", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(["ok"]))
        };
        const processor = new OcrProcessor({
            languageModel: createModel(session)
        });

        await processor.processImage(
            { name: "doc.png" },
            { preprocess: false, customPrompt: "Find all dates" }
        );

        const promptArg = session.promptStreaming.mock.calls[0][0];
        expect(promptArg[0].content[1].value).toBe("Find all dates");
    });

    it("pretty-prints JSON results and leaves invalid JSON untouched", () => {
        expect(formatResult('{"a":1}', "json")).toBe('{\n  "a": 1\n}');
        expect(formatResult("not json", "json")).toBe("not json");
        expect(formatResult('{"a":1}', "text")).toBe('{"a":1}');
    });

    it("collects per-file results and errors in batch statistics", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValueOnce(createStreamFromChunks(["first"]))
                .mockImplementationOnce(() => {
                    throw new Error("second failed");
                })
        };
        const processor = new OcrProcessor({
            languageModel: createModel(session)
        });

        const batch = await processor.processBatch(
            [{ name: "a.png" }, { name: "b.png" }],
            { preprocess: false }
        );

        expect(batch.results).toEqual({ "a.png": "first" });
        expect(batch.errors).toEqual({ "b.png": "second failed" });
        expect(batch.statistics).toEqual({
            total: 2,
            successful: 1,
            failed: 1
        });
    });

    it("reports unavailable without the Prompt API", async () => {
        const processor = new OcrProcessor({ languageModel: undefined });
        expect(processor.isSupported).toBe(false);
        await expect(processor.availability()).resolves.toBe("unavailable");
        await expect(
            processor.processImage({ name: "a.png" }, { preprocess: false })
        ).rejects.toThrow("Prompt API");
    });
});
