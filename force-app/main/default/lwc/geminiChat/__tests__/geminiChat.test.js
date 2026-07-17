import { createElement } from "lwc";
import GeminiChat from "c/geminiChat";

const NAMESPACE = "geminiChatLocalLlm";

function flushPromises() {
    return Promise.resolve().then(() => Promise.resolve());
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

function findByProp(root, selector, prop, value) {
    return [...root.querySelectorAll(selector)].find(
        (node) => node[prop] === value
    );
}

function sendEngineMessage(data) {
    window.dispatchEvent(
        new MessageEvent("message", {
            data: { namespace: NAMESPACE, ...data }
        })
    );
}

describe("c-gemini-chat", () => {
    afterEach(() => {
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        delete window.LanguageModel;
        delete window.ai;
        jest.clearAllMocks();
    });

    function mountWithModel(model) {
        window.LanguageModel = model;
        const element = createElement("c-gemini-chat", { is: GeminiChat });
        document.body.appendChild(element);
        return element;
    }

    async function typePrompt(element, text) {
        const textarea = findByProp(
            element.shadowRoot,
            "lightning-textarea",
            "name",
            "prompt"
        );
        textarea.value = text;
        textarea.dispatchEvent(new CustomEvent("change"));
        await flushPromises();
    }

    function clickButton(element, label) {
        findByProp(
            element.shadowRoot,
            "lightning-button",
            "label",
            label
        ).click();
    }

    function statusText(element) {
        return element.shadowRoot.querySelector(".slds-text-body_small")
            .textContent;
    }

    it("reports unsupported when no Prompt API is present", async () => {
        const element = createElement("c-gemini-chat", { is: GeminiChat });
        document.body.appendChild(element);
        await flushPromises();

        expect(statusText(element)).toContain("does not expose");
    });

    it("shows ready status when model is available", async () => {
        const element = mountWithModel({
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn()
        });
        await flushPromises();

        expect(statusText(element)).toContain("ready");
    });

    it("offers a download button when model is downloadable", async () => {
        const element = mountWithModel({
            availability: jest.fn().mockResolvedValue("downloadable"),
            create: jest.fn()
        });
        await flushPromises();

        const button = findByProp(
            element.shadowRoot,
            "lightning-button",
            "label",
            "Download model"
        );
        expect(button).toBeDefined();
    });

    it("streams delta chunks from the Prompt API into the assistant message", async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(["Hello", " world"])),
            destroy: jest.fn()
        };
        const model = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockResolvedValue(session)
        };
        const element = mountWithModel(model);
        await flushPromises();

        await typePrompt(element, "Hi there");
        clickButton(element, "Send");

        await flushPromises();
        await flushPromises();

        expect(model.create).toHaveBeenCalledWith(
            expect.not.objectContaining({ temperature: expect.anything() })
        );
        expect(session.promptStreaming).toHaveBeenCalledWith(
            "Hi there",
            expect.objectContaining({ signal: expect.anything() })
        );

        const assistant = element.shadowRoot.querySelector(
            ".gemini-message_assistant .gemini-message__text"
        );
        expect(assistant.textContent).toBe("Hello world");
    });

    it("surfaces an error message when session creation fails", async () => {
        const model = {
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn().mockRejectedValue(new Error("boom"))
        };
        const element = mountWithModel(model);
        await flushPromises();

        await typePrompt(element, "Hi");
        clickButton(element, "Send");

        await flushPromises();
        await flushPromises();

        const alert = element.shadowRoot.querySelector('[role="alert"]');
        expect(alert.textContent).toContain("boom");
    });

    describe("client-side fallback", () => {
        async function mountUnsupportedAndLoadFallback() {
            const element = createElement("c-gemini-chat", { is: GeminiChat });
            document.body.appendChild(element);
            await flushPromises();

            clickButton(element, "Load local fallback model");
            await flushPromises();

            const runner =
                element.shadowRoot.querySelector("c-local-llm-runner");
            const postedMessages = [];
            const iframe = runner.shadowRoot.querySelector("iframe");
            Object.defineProperty(iframe, "contentWindow", {
                value: {
                    postMessage: (message) => postedMessages.push(message)
                }
            });

            return { element, runner, postedMessages };
        }

        it("offers the fallback when the Prompt API is unsupported", async () => {
            const element = createElement("c-gemini-chat", { is: GeminiChat });
            document.body.appendChild(element);
            await flushPromises();

            const button = findByProp(
                element.shadowRoot,
                "lightning-button",
                "label",
                "Load local fallback model"
            );
            expect(button).toBeDefined();
        });

        it("initializes the fallback model and reports readiness", async () => {
            const { element, postedMessages } =
                await mountUnsupportedAndLoadFallback();

            sendEngineMessage({ type: "ready" });
            expect(postedMessages).toEqual([
                expect.objectContaining({
                    type: "init",
                    modelId: "onnx-community/Qwen2.5-0.5B-Instruct"
                })
            ]);

            sendEngineMessage({ type: "initialized", device: "webgpu" });
            await flushPromises();

            expect(statusText(element)).toContain("running locally");
            expect(statusText(element)).toContain("WebGPU");
        });

        it("generates a response through the fallback engine", async () => {
            const { element, postedMessages } =
                await mountUnsupportedAndLoadFallback();
            sendEngineMessage({ type: "ready" });
            sendEngineMessage({ type: "initialized", device: "wasm" });
            await flushPromises();

            await typePrompt(element, "Hi fallback");
            clickButton(element, "Send");
            await flushPromises();

            const generateMessage = postedMessages.find(
                (message) => message.type === "generate"
            );
            expect(generateMessage).toBeDefined();
            expect(generateMessage.messages[0].role).toBe("system");
            expect(
                generateMessage.messages[generateMessage.messages.length - 1]
            ).toEqual({ role: "user", content: "Hi fallback" });

            sendEngineMessage({
                type: "chunk",
                id: generateMessage.id,
                text: "Local "
            });
            sendEngineMessage({
                type: "chunk",
                id: generateMessage.id,
                text: "answer"
            });
            sendEngineMessage({ type: "done", id: generateMessage.id });
            await flushPromises();

            const assistant = element.shadowRoot.querySelector(
                ".gemini-message_assistant .gemini-message__text"
            );
            expect(assistant.textContent).toBe("Local answer");
        });

        it("shows an error when fallback initialization fails", async () => {
            const { element } = await mountUnsupportedAndLoadFallback();
            sendEngineMessage({ type: "ready" });
            sendEngineMessage({
                type: "error",
                message: "Failed to initialize model: out of memory"
            });
            await flushPromises();

            const alert = element.shadowRoot.querySelector('[role="alert"]');
            expect(alert.textContent).toContain("out of memory");
        });
    });
});
