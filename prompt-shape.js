/**
 * Applies SillyTavern's "Squash system messages" transform to an assembled chat-completion prompt.
 *
 * SillyTavern squashes only live requests, never dry runs, so the keepalive prompt has to apply it
 * itself. Without it Claude sees a differently shaped system prompt, and the keepalive warms a
 * cache entry that the next real message can never read.
 *
 * Mirrors ChatCompletion.squashSystemMessages(): empty system messages are dropped and consecutive
 * unnamed system messages are joined with a newline. SillyTavern keeps the new-chat, example-chat
 * and group-nudge prompts separate by prompt id; assembled messages no longer carry ids, so those
 * prompts are recognized by their rendered text instead.
 * @param {object[]} chat Chat-completion messages.
 * @param {Iterable<string>} separateContents Rendered texts of the prompts that stay separate.
 * @returns {object[]} A new message array; the input messages are not modified.
 */
export function squashSystemMessages(chat, separateContents = []) {
    const separate = new Set(separateContents);
    const squashable = message => message?.role === 'system' && !message.name && !separate.has(message.content);
    const squashed = [];
    for (const message of chat) {
        if (message?.role === 'system' && !message.content) {
            continue;
        }
        const last = squashed.at(-1);
        if (squashable(message) && squashable(last)) {
            squashed[squashed.length - 1] = { ...last, content: `${last.content}\n${message.content}` };
        } else {
            squashed.push(message);
        }
    }
    return squashed;
}
