export interface JsonMessage {
  type: string;
  id?: string;
  ok?: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  status?: string;
  event?: {
    taskId: string;
    seq: number;
    type: string;
    data: Record<string, unknown>;
  };
}

export class ProtocolClient {
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly messages: JsonMessage[] = [];
  private readonly waiters = new Set<{
    predicate: (message: JsonMessage) => boolean;
    resolve: (message: JsonMessage) => void;
  }>();

  constructor(
    command: string[],
    cwd: string,
    environment: Record<string, string | undefined>,
  ) {
    this.process = Bun.spawn({
      cmd: command,
      cwd,
      env: environment,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.readLoop();
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of this.process.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          const message = JSON.parse(line) as JsonMessage;
          this.messages.push(message);
          for (const waiter of [...this.waiters]) {
            if (waiter.predicate(message)) {
              waiter.resolve(message);
            }
          }
        }
        newline = buffer.indexOf("\n");
      }
    }
  }

  send(message: Record<string, unknown>): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
    this.process.stdin.flush();
  }

  waitFor(
    predicate: (message: JsonMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<JsonMessage> {
    const existing = this.messages.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve: (message: JsonMessage) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("等待协议消息超时"));
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  async stop(): Promise<void> {
    this.send({ type: "shutdown" });
    await this.process.exited;
  }
}
