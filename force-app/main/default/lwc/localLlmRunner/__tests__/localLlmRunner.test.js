import { createElement } from "lwc";
import LocalLlmRunner from "c/localLlmRunner";

const NAMESPACE = "geminiChatLocalLlm";

function flushPromises() {
    return Promise.resolve().then(() => Promise.resolve());
}

function sendEngineMessage(data) {
    window.dispatchEvent(
        new MessageEvent("message", {
            data: { namespace: NAMESPACE, ...data }
        })
    );
}

describe("c-local-llm-runner", () => {
    let element;
    let postedMessages;

    beforeEach(() => {
        element = createElement("c-local-llm-runner", { is: LocalLlmRunner });
        document.body.appendChild(element);
        postedMessages = [];
        const iframe = element.shadowRoot.querySelector("iframe");
        Object.defineProperty(iframe, "contentWindow", {
            value: {
                postMessage: (message) => postedMessages.push(message)
            }
        });
    });

    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
    });

    it("queues init until the engine reports ready", async () => {
        const initPromise = element.initialize("test/model");
        expect(postedMessages).toHaveLength(0);

        sendEngineMessage({ type: "ready" });
        expect(postedMessages).toEqual([
            expect.objectContaining({ type: "init", modelId: "test/model" })
        ]);

        sendEngineMessage({ type: "initialized", device: "wasm" });
        await expect(initPromise).resolves.toEqual({ device: "wasm" });
    });

    it("emits progress events during model download", async () => {
        const progressHandler = jest.fn();
        element.addEventListener("progress", progressHandler);
        element.initialize("test/model");
        sendEngineMessage({ type: "ready" });

        sendEngineMessage({ type: "progress", loaded: 0.42 });
        await flushPromises();

        expect(progressHandler).toHaveBeenCalledTimes(1);
        expect(progressHandler.mock.calls[0][0].detail).toEqual({
            loaded: 0.42
        });
    });

    it("streams chunks and resolves generate with the full text", async () => {
        sendEngineMessage({ type: "ready" });
        const chunkHandler = jest.fn();
        element.addEventListener("chunk", chunkHandler);

        const generatePromise = element.generate([
            { role: "user", content: "Hi" }
        ]);
        const generateMessage = postedMessages.find(
            (message) => message.type === "generate"
        );
        expect(generateMessage).toBeDefined();

        sendEngineMessage({
            type: "chunk",
            id: generateMessage.id,
            text: "Hello"
        });
        sendEngineMessage({
            type: "chunk",
            id: generateMessage.id,
            text: " world"
        });
        sendEngineMessage({ type: "done", id: generateMessage.id });

        await expect(generatePromise).resolves.toBe("Hello world");
        expect(chunkHandler).toHaveBeenCalledTimes(2);
        expect(chunkHandler.mock.calls[1][0].detail).toEqual({
            text: " world",
            fullText: "Hello world"
        });
    });

    it("rejects generate when the engine reports an error", async () => {
        sendEngineMessage({ type: "ready" });
        const generatePromise = element.generate([
            { role: "user", content: "Hi" }
        ]);
        const generateMessage = postedMessages.find(
            (message) => message.type === "generate"
        );

        sendEngineMessage({
            type: "error",
            id: generateMessage.id,
            message: "engine exploded"
        });

        await expect(generatePromise).rejects.toThrow("engine exploded");
    });

    it("rejects initialize when the engine fails to load", async () => {
        const initPromise = element.initialize("test/model");
        sendEngineMessage({ type: "ready" });
        sendEngineMessage({
            type: "error",
            message: "Failed to initialize model: no webgpu"
        });

        await expect(initPromise).rejects.toThrow("no webgpu");
    });

    it("passes the task through when initializing", () => {
        element.initialize("test/vision-model", "vision");
        sendEngineMessage({ type: "ready" });
        expect(postedMessages).toEqual([
            expect.objectContaining({
                type: "init",
                modelId: "test/vision-model",
                task: "vision"
            })
        ]);
    });

    it("sends vision payloads with prompt and image", () => {
        sendEngineMessage({ type: "ready" });
        element.generate({
            prompt: "Extract text",
            image: "data:image/png;base64,abc"
        });
        expect(postedMessages).toEqual([
            expect.objectContaining({
                type: "generate",
                prompt: "Extract text",
                image: "data:image/png;base64,abc"
            })
        ]);
    });

    it("streams an Ollama generation through the engine", async () => {
        sendEngineMessage({ type: "ready" });
        const generatePromise = element.ollamaGenerate({
            endpoint: "http://localhost:11434",
            model: "llama3.2-vision:11b",
            prompt: "Extract text",
            imageBase64: "abc123"
        });
        const message = postedMessages.find(
            (posted) => posted.type === "ollamaGenerate"
        );
        expect(message).toEqual(
            expect.objectContaining({
                endpoint: "http://localhost:11434",
                model: "llama3.2-vision:11b",
                prompt: "Extract text",
                imageBase64: "abc123"
            })
        );

        sendEngineMessage({ type: "chunk", id: message.id, text: "OCR " });
        sendEngineMessage({ type: "chunk", id: message.id, text: "output" });
        sendEngineMessage({ type: "done", id: message.id });

        await expect(generatePromise).resolves.toBe("OCR output");
    });

    it("sends a stop message to the engine", () => {
        sendEngineMessage({ type: "ready" });
        element.stop();
        expect(postedMessages).toEqual([
            expect.objectContaining({ type: "stop" })
        ]);
    });

    it("ignores messages without the expected namespace", async () => {
        const progressHandler = jest.fn();
        element.addEventListener("progress", progressHandler);
        window.dispatchEvent(
            new MessageEvent("message", {
                data: { type: "progress", loaded: 0.9 }
            })
        );
        await flushPromises();
        expect(progressHandler).not.toHaveBeenCalled();
    });
});
