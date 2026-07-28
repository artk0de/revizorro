/**
 * The webview's one channel back to the extension.
 *
 * `acquireVsCodeApi()` may only be called once per webview and does not exist
 * outside one, so the components post through this indirection instead of reaching
 * for the global: the bootstrap wires the real API in, tests wire a spy in.
 */
type PostMessage = (message: unknown) => void;

let post: PostMessage = () => {
  // No bridge yet — dropping the message is better than throwing inside a render.
};

export function setBridge(fn: PostMessage): void {
  post = fn;
}

export function send(message: unknown): void {
  post(message);
}
