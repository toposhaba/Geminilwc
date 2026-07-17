import { createElement } from "lwc";
import VisionOcr from "c/visionOcr";

jest.mock("c/imagePreprocessor", () => ({
    preprocessImageBlob: jest.fn((blob) => Promise.resolve(blob))
}));

const NAMESPACE = "geminiChatLocalLlm";

function flushPromises() {
    return Promise.resolve().then(() => Promise.resolve());
}

async function waitFor(condition, timeout = 2000) {
    const start = Date.now();
    for (;;) {
        if (condition()) {
            return;
        }
        if (Date.now() - start > timeout) {
            throw new Error("Timed out waiting for condition");
        }
        await new Promise((resolve) => {
            setTimeout(resolve, 10);
        });
    }
}

function sendEngineMessage(data) {
    window.dispatchEvent(
        new MessageEvent("message", {
            data: { namespace: NAMESPACE, ...data }
        })
    );
}

function findByProp(root, selector, prop, value) {
    return [...root.querySelectorAll(selector)].find(
        (node) => node[prop] === value
    );
}

function createStreamFromChunks(chunks) {
    return {
        async *[Symbol.asyncIterator]() {
            for (const chunk of chunks) {
                yield chunk;
            }
        }
    };
}

describe("c-vision-ocr", () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        delete window.LanguageModel;
        jest.clearAllMocks();
    });

    function mount() {
        const element = createElement("c-vision-ocr", { is: VisionOcr });
        document.body.appendChild(element);
        return element;
    }

    async function selectImages(element, names = ["doc.png"]) {
        const files = names.map(
            (name) =>
                new File(["fake-image-bytes"], name, { type: "image/png" })
        );
        const input = element.shadowRoot.querySelector('input[type="file"]');
        Object.defineProperty(input, "files", {
            value: files,
            configurable: true
        });
        input.dispatchEvent(new CustomEvent("change"));
        await waitFor(() =>
            Boolean(element.shadowRoot.querySelector(".ocr-preview img"))
        );
        return files;
    }

    function stubRunnerIframe(element) {
        const runner = element.shadowRoot.querySelector("c-local-llm-runner");
        const postedMessages = [];
        const iframe = runner.shadowRoot.querySelector("iframe");
        Object.defineProperty(iframe, "contentWindow", {
            value: {
                postMessage: (message) => postedMessages.push(message)
            }
        });
        return postedMessages;
    }

    function setCombobox(element, label, value) {
        const combobox = findByProp(
            element.shadowRoot,
            "lightning-combobox",
            "label",
            label
        );
        combobox.dispatchEvent(
            new CustomEvent("change", { detail: { value } })
        );
    }

    function clickExtract(element) {
        findByProp(
            element.shadowRoot,
            "lightning-button",
            "label",
            "Extract text"
        ).click();
    }

    it("falls back to the local engine when Gemini Nano is unsupported", async () => {
        const element = mount();
        await flushPromises();

        const status = element.shadowRoot.querySelector(
            ".slds-text-body_small"
        );
        expect(status.textContent).toContain("Local vision model");
        expect(
            element.shadowRoot.querySelector("c-local-llm-runner")
        ).not.toBeNull();
    });

    it("runs OCR through the local Transformers.js engine", async () => {
        const element = mount();
        await flushPromises();
        const postedMessages = stubRunnerIframe(element);
        await selectImages(element);

        clickExtract(element);
        await flushPromises();

        sendEngineMessage({ type: "ready" });
        await waitFor(() =>
            postedMessages.some((message) => message.type === "init")
        );
        expect(
            postedMessages.find((message) => message.type === "init")
        ).toEqual(
            expect.objectContaining({
                modelId: "HuggingFaceTB/SmolVLM-256M-Instruct",
                task: "vision"
            })
        );

        sendEngineMessage({ type: "initialized", device: "wasm" });
        await waitFor(() =>
            postedMessages.some((message) => message.type === "generate")
        );
        const generateMessage = postedMessages.find(
            (message) => message.type === "generate"
        );
        expect(generateMessage.prompt).toContain("markdown");
        expect(generateMessage.image).toContain("data:image/png;base64");

        sendEngineMessage({
            type: "chunk",
            id: generateMessage.id,
            text: "# Extracted"
        });
        sendEngineMessage({ type: "done", id: generateMessage.id });
        await waitFor(() =>
            Boolean(element.shadowRoot.querySelector(".ocr-result pre"))
        );

        expect(
            element.shadowRoot.querySelector(".ocr-result pre").textContent
        ).toBe("# Extracted");
    });

    it("runs OCR through the built-in Gemini Nano when available", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(["Total: ", "$100"])),
            destroy: jest.fn()
        };
        window.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue(session)
        };
        const element = mount();
        await flushPromises();

        const [imageFile] = await selectImages(element);
        clickExtract(element);
        await waitFor(() =>
            Boolean(element.shadowRoot.querySelector(".ocr-result pre"))
        );

        expect(window.LanguageModel.availability).toHaveBeenCalledWith({
            expectedInputs: [{ type: "image" }]
        });
        expect(window.LanguageModel.create).toHaveBeenCalledWith({
            expectedInputs: [{ type: "image" }]
        });
        const promptArg = session.promptStreaming.mock.calls[0][0];
        expect(promptArg[0].content[0]).toEqual({
            type: "image",
            value: imageFile
        });
        expect(promptArg[0].content[1].value).toContain("markdown");

        expect(
            element.shadowRoot.querySelector(".ocr-result pre").textContent
        ).toBe("Total: $100");
    });

    it("processes multiple images and reports batch statistics", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValueOnce(createStreamFromChunks(["first result"]))
                .mockImplementationOnce(() => {
                    throw new Error("model exploded");
                }),
            destroy: jest.fn()
        };
        window.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue(session)
        };
        const element = mount();
        await flushPromises();

        await selectImages(element, ["a.png", "b.png"]);
        clickExtract(element);
        await waitFor(
            () =>
                element.shadowRoot.querySelectorAll(".ocr-result").length === 2
        );

        const results = element.shadowRoot.querySelectorAll(".ocr-result");
        expect(results[0].querySelector("pre").textContent).toBe(
            "first result"
        );
        expect(
            results[1].querySelector(".slds-text-color_error").textContent
        ).toBe("model exploded");

        await waitFor(() =>
            Boolean(element.shadowRoot.textContent.includes("succeeded"))
        );
        expect(element.shadowRoot.textContent).toContain(
            "1 succeeded, 1 failed, 2 total"
        );
    });

    it("pretty-prints valid JSON results", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(['{"total":100}'])),
            destroy: jest.fn()
        };
        window.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue(session)
        };
        const element = mount();
        await flushPromises();

        setCombobox(element, "Output format", "json");
        await selectImages(element);
        clickExtract(element);
        await waitFor(() =>
            Boolean(element.shadowRoot.querySelector(".ocr-result pre"))
        );
        await waitFor(() =>
            element.shadowRoot
                .querySelector(".ocr-result pre")
                .textContent.includes("\n")
        );

        expect(
            element.shadowRoot.querySelector(".ocr-result pre").textContent
        ).toBe('{\n  "total": 100\n}');
    });

    it("uses the custom prompt when the custom format is selected", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(["ok"])),
            destroy: jest.fn()
        };
        window.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue(session)
        };
        const element = mount();
        await flushPromises();

        setCombobox(element, "Output format", "custom");
        await flushPromises();
        const customPromptInput = findByProp(
            element.shadowRoot,
            "lightning-textarea",
            "label",
            "Custom prompt"
        );
        customPromptInput.value = "List every phone number in the image";
        customPromptInput.dispatchEvent(new CustomEvent("change"));

        await selectImages(element);
        clickExtract(element);
        await waitFor(() => session.promptStreaming.mock.calls.length > 0);

        const promptArg = session.promptStreaming.mock.calls[0][0];
        expect(promptArg[0].content[1].value).toBe(
            "List every phone number in the image"
        );
    });

    it("skips preprocessing when the toggle is turned off", async () => {
        const { preprocessImageBlob } = require("c/imagePreprocessor");
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(["ok"])),
            destroy: jest.fn()
        };
        window.LanguageModel = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue(session)
        };
        const element = mount();
        await flushPromises();

        const toggle = findByProp(
            element.shadowRoot,
            "lightning-input",
            "type",
            "checkbox"
        );
        toggle.checked = false;
        toggle.dispatchEvent(new CustomEvent("change"));

        await selectImages(element);
        clickExtract(element);
        await waitFor(() => session.promptStreaming.mock.calls.length > 0);

        expect(preprocessImageBlob).not.toHaveBeenCalled();
    });
});
