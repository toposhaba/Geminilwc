const NAMESPACE = "geminiChatLocalLlm";

export function createRunner(iframe) {
    let ready = false;
    const outbox = [];
    let requestId = 0;
    let initDeferred;
    let active;

    function deferred() {
        const box = {};
        box.promise = new Promise((resolve, reject) => {
            box.resolve = resolve;
            box.reject = reject;
        });
        return box;
    }

    function post(message) {
        if (!ready) {
            outbox.push(message);
            return;
        }
        iframe.contentWindow.postMessage(
            { namespace: NAMESPACE, ...message },
            "*"
        );
    }

    window.addEventListener("message", (event) => {
        const data = event.data;
        if (!data || data.namespace !== NAMESPACE) {
            return;
        }
        if (event.source && event.source !== iframe.contentWindow) {
            return;
        }
        if (data.type === "ready") {
            ready = true;
            const queued = outbox.splice(0, outbox.length);
            queued.forEach(post);
        } else if (data.type === "progress") {
            iframe.dispatchEvent(
                new CustomEvent("engineprogress", {
                    detail: { loaded: data.loaded }
                })
            );
        } else if (data.type === "initialized") {
            initDeferred?.resolve({ device: data.device });
        } else if (data.type === "chunk" && active && active.id === data.id) {
            active.text += data.text;
            iframe.dispatchEvent(
                new CustomEvent("enginechunk", {
                    detail: { text: data.text, fullText: active.text }
                })
            );
        } else if (data.type === "done" && active && active.id === data.id) {
            const current = active;
            active = undefined;
            current.resolve(current.text);
        } else if (data.type === "error") {
            const error = new Error(data.message || "Engine error");
            if (data.id && active && active.id === data.id) {
                const current = active;
                active = undefined;
                current.reject(error);
            } else {
                initDeferred?.reject(error);
            }
        }
    });

    return {
        initialize(modelId, task) {
            if (!initDeferred) {
                initDeferred = deferred();
                post({ type: "init", modelId, task: task || "text" });
            }
            return initDeferred.promise;
        },
        generate(payload) {
            if (active) {
                return Promise.reject(new Error("Already generating"));
            }
            requestId += 1;
            const id = `req-${requestId}`;
            active = { id, text: "", ...deferred() };
            const body = Array.isArray(payload)
                ? { messages: payload }
                : payload;
            post({ type: "generate", id, maxNewTokens: 40, ...body });
            return active.promise;
        },
        stop() {
            post({ type: "stop" });
        }
    };
}

export async function promptApiAvailability(expectedInputs) {
    if (!window.LanguageModel) {
        return "unsupported";
    }
    try {
        return await window.LanguageModel.availability(
            expectedInputs ? { expectedInputs } : undefined
        );
    } catch (error) {
        return "unavailable";
    }
}

export async function promptStreaming(content, onChunk, signal) {
    const session = await window.LanguageModel.create(
        Array.isArray(content[0]?.content)
            ? { expectedInputs: [{ type: "image" }] }
            : {}
    );
    const stream = session.promptStreaming(content, { signal });
    let full = "";
    for await (const chunk of stream) {
        full += chunk;
        onChunk(full);
    }
    return full;
}
