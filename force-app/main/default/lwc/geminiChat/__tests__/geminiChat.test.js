import { createElement } from 'lwc';
import GeminiChat from 'c/geminiChat';

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

describe('c-gemini-chat', () => {
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
        const element = createElement('c-gemini-chat', { is: GeminiChat });
        document.body.appendChild(element);
        return element;
    }

    it('reports unsupported when no Prompt API is present', async () => {
        const element = createElement('c-gemini-chat', { is: GeminiChat });
        document.body.appendChild(element);
        await flushPromises();

        const status = element.shadowRoot.querySelector('.slds-text-body_small');
        expect(status.textContent).toContain('does not expose');
    });

    it('shows ready status when model is available', async () => {
        mountWithModel({
            availability: jest.fn().mockResolvedValue('available'),
            create: jest.fn()
        });
        await flushPromises();

        const status = document.body
            .querySelector('c-gemini-chat')
            .shadowRoot.querySelector('.slds-text-body_small');
        expect(status.textContent).toContain('ready');
    });

    it('offers a download button when model is downloadable', async () => {
        const element = mountWithModel({
            availability: jest.fn().mockResolvedValue('downloadable'),
            create: jest.fn()
        });
        await flushPromises();

        const button = element.shadowRoot.querySelector(
            'lightning-button[label="Download model"]'
        );
        expect(button).not.toBeNull();
    });

    it('streams a response and renders assistant text', async () => {
        const session = {
            promptStreaming: jest
                .fn()
                .mockReturnValue(createStreamFromChunks(['Hello', ' world'])),
            destroy: jest.fn()
        };
        const model = {
            availability: jest.fn().mockResolvedValue('available'),
            create: jest.fn().mockResolvedValue(session)
        };
        const element = mountWithModel(model);
        await flushPromises();

        const textarea = element.shadowRoot.querySelector(
            'lightning-textarea[name="prompt"]'
        );
        textarea.value = 'Hi there';
        textarea.dispatchEvent(new CustomEvent('change', { target: textarea }));

        const sendButton = element.shadowRoot.querySelector(
            'lightning-button[label="Send"]'
        );
        sendButton.click();

        await flushPromises();
        await flushPromises();

        expect(model.create).toHaveBeenCalled();
        expect(session.promptStreaming).toHaveBeenCalledWith(
            'Hi there',
            expect.objectContaining({ signal: expect.anything() })
        );

        const assistant = element.shadowRoot.querySelector(
            '.gemini-message_assistant .gemini-message__text'
        );
        expect(assistant.textContent).toBe('Hello world');
    });

    it('surfaces an error message when session creation fails', async () => {
        const model = {
            availability: jest.fn().mockResolvedValue('available'),
            create: jest.fn().mockRejectedValue(new Error('boom'))
        };
        const element = mountWithModel(model);
        await flushPromises();

        const textarea = element.shadowRoot.querySelector(
            'lightning-textarea[name="prompt"]'
        );
        textarea.value = 'Hi';
        textarea.dispatchEvent(new CustomEvent('change', { target: textarea }));

        element.shadowRoot
            .querySelector('lightning-button[label="Send"]')
            .click();

        await flushPromises();
        await flushPromises();

        const alert = element.shadowRoot.querySelector('[role="alert"]');
        expect(alert.textContent).toContain('boom');
    });
});
