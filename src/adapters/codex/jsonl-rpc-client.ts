import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ExternalAgentProtocolError } from "../../core/errors.js";

export type JsonRpcId = number | string;

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  cleanup?: () => void;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface CodexJsonlRpcClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientVersion: string;
}

export class CodexJsonlRpcClient {
  readonly #options: CodexJsonlRpcClientOptions;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  readonly #notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  readonly #transportErrorListeners = new Set<(error: Error) => void>();
  #process: ChildProcessWithoutNullStreams | undefined;
  #startPromise: Promise<void> | undefined;
  #exitPromise: Promise<void> | undefined;
  #nextId = 1;
  #stdoutBuffer = "";
  #stderrTail = "";
  #closed = false;
  #serverRequestHandler?: (request: JsonRpcServerRequest) => Promise<unknown>;

  constructor(options: CodexJsonlRpcClientOptions) {
    this.#options = options;
  }

  setServerRequestHandler(handler: (request: JsonRpcServerRequest) => Promise<unknown>): void {
    this.#serverRequestHandler = handler;
  }

  subscribe(
    listener: (notification: JsonRpcNotification) => void,
    onTransportError?: (error: Error) => void,
  ): () => void {
    this.#notificationListeners.add(listener);
    if (onTransportError) this.#transportErrorListeners.add(onTransportError);
    return () => {
      this.#notificationListeners.delete(listener);
      if (onTransportError) this.#transportErrorListeners.delete(onTransportError);
    };
  }

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.#closed) throw new ExternalAgentProtocolError("codex", "Codex app-server client is closed");
    if (!this.#startPromise) this.#startPromise = this.#spawnAndInitialize();
    await this.#startPromise;
    signal?.throwIfAborted();
  }

  async request<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    await this.start(signal);
    return (await this.#requestRaw(method, params, signal)) as T;
  }

  notify(method: string, params: unknown): void {
    this.#write({ method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#process;
    if (!child) return;

    child.stdin.end();
    const exited = this.#exitPromise;
    if (!exited || (await settlesWithin(exited, 750))) return;

    child.kill("SIGTERM");
    if (await settlesWithin(exited, 2_000)) return;
    child.kill("SIGKILL");
    await exited;
  }

  async #spawnAndInitialize(): Promise<void> {
    const child = spawn(this.#options.command, this.#options.args, {
      cwd: this.#options.cwd,
      env: this.#options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#process = child;
    this.#stdoutBuffer = "";
    this.#stderrTail = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#consumeStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-16_384);
    });
    this.#exitPromise = new Promise<void>((resolve) => {
      child.once("close", (code, signal) => {
        this.#handleExit(code, signal);
        resolve();
      });
    });
    child.on("error", (error) => {
      this.#rejectAll(
        new ExternalAgentProtocolError("codex", `Codex app-server process error: ${error.message}`, {
          cause: error,
        }),
      );
    });

    try {
      await waitForSpawn(child);
      await this.#requestRaw("initialize", {
        clientInfo: {
          name: "pi_agent_bridge",
          title: "Pi Agent Bridge",
          version: this.#options.clientVersion,
        },
      });
      this.notify("initialized", {});
    } catch (error) {
      this.#startPromise = undefined;
      if (!child.killed) child.kill("SIGTERM");
      throw new ExternalAgentProtocolError(
        "codex",
        `Could not start Codex app-server with ${this.#options.command}: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  #requestRaw(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (signal) {
        const abort = () => {
          this.#pending.delete(id);
          reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.cleanup = () => signal.removeEventListener("abort", abort);
      }

      this.#pending.set(id, pending);
      try {
        this.#write({ method, id, params });
      } catch (error) {
        this.#pending.delete(id);
        pending.cleanup?.();
        reject(error);
      }
    });
  }

  #write(message: unknown): void {
    const child = this.#process;
    if (!child?.stdin.writable) {
      throw new ExternalAgentProtocolError("codex", "Codex app-server stdin is not writable");
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consumeStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    const records = this.#stdoutBuffer.split("\n");
    this.#stdoutBuffer = records.pop() ?? "";
    for (const record of records) {
      if (record.trim()) this.#consumeRecord(record);
    }
  }

  #consumeRecord(record: string): void {
    let message: unknown;
    try {
      message = JSON.parse(record);
    } catch (error) {
      this.#rejectAll(
        new ExternalAgentProtocolError("codex", "Codex app-server emitted invalid JSON", { cause: error }),
      );
      return;
    }

    if (!isRecord(message)) return;
    if ("method" in message && typeof message.method === "string") {
      // SAFETY: method was validated above; params is intentionally opaque protocol data.
      const notification = message as unknown as JsonRpcNotification;
      if ("id" in message && isJsonRpcId(message.id)) {
        void this.#handleServerRequest({ ...notification, id: message.id });
      } else {
        for (const listener of this.#notificationListeners) listener(notification);
      }
      return;
    }

    if (!("id" in message) || !isJsonRpcId(message.id)) return;
    // SAFETY: id was validated above; result/error remain opaque until the caller decodes them.
    const response = message as unknown as JsonRpcResponse;
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    pending.cleanup?.();

    if (response.error) {
      pending.reject(
        new ExternalAgentProtocolError(
          "codex",
          `Codex RPC error ${response.error.code}: ${response.error.message}`,
        ),
      );
    } else {
      pending.resolve(response.result);
    }
  }

  async #handleServerRequest(request: JsonRpcServerRequest): Promise<void> {
    try {
      if (!this.#serverRequestHandler) {
        this.#write({
          id: request.id,
          error: { code: -32601, message: `Unsupported server request: ${request.method}` },
        });
        return;
      }
      const result = await this.#serverRequestHandler(request);
      this.#write({ id: request.id, result });
    } catch (error) {
      this.#write({
        id: request.id,
        error: { code: -32000, message: errorMessage(error) },
      });
    }
  }

  #handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#process = undefined;
    this.#startPromise = undefined;
    this.#exitPromise = undefined;
    if (this.#closed) return;

    const suffix = this.#stderrTail.trim() ? `\n${this.#stderrTail.trim()}` : "";
    this.#rejectAll(
      new ExternalAgentProtocolError(
        "codex",
        `Codex app-server exited unexpectedly (code ${code ?? "none"}, signal ${signal ?? "none"}).${suffix}`,
      ),
    );
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.cleanup?.();
      pending.reject(error);
    }
    this.#pending.clear();
    for (const listener of this.#transportErrorListeners) listener(error);
  }
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    const spawned = () => {
      child.removeListener("error", failed);
      resolve();
    };
    const failed = (error: Error) => {
      child.removeListener("spawn", spawned);
      reject(error);
    };
    child.once("spawn", spawned);
    child.once("error", failed);
  });
}

function settlesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), timeoutMs);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
      () => {
        clearTimeout(timeout);
        resolve(true);
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || typeof value === "number";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
