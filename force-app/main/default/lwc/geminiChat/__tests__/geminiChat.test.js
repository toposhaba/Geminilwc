import { createElement } from "lwc";
import GeminiChat from "c/geminiChat";

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

    it("reports unsupported when no Prompt API is present", async () => {
        const element = createElement("c-gemini-chat", { is: GeminiChat });
        document.body.appendChild(element);
        await flushPromises();

        const status = element.shadowRoot.querySelector(
            ".slds-text-body_small"
        );
        expect(status.textContent).toContain("does not expose");
    });

    it("shows ready status when model is available", async () => {
        const element = mountWithModel({
            availability: jest.fn().mockResolvedValue("available"),
            create: jest.fn()
        });
        await flushPromises();

        const status = element.shadowRoot.querySelector(
            ".slds-text-body_small"
        );
        expect(status.textContent).toContain("ready");
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

    it("streams a response and renders assistant text", async () => {
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

        expect(model.create).toHaveBeenCalled();
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
});
