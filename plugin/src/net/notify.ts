import type { ChangeNotification, PresenceNotification, SameFileWarning } from "../types";

export type NotifyMessage = ChangeNotification | PresenceNotification | SameFileWarning;

export interface NotifyClientOptions {
  serverUrl: string;
  vaultId: string;
  token: string;
  onOpen?: (reconnected: boolean) => void | Promise<void>;
  onMessage?: (message: NotifyMessage) => void | Promise<void>;
  onClose?: () => void;
}

export class NotifyClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private reconnectDelayMs = 1000;
  private everOpened = false;
  private closed = false;

  constructor(private readonly options: NotifyClientOptions) {}

  connect() {
    if (this.closed || this.socket) return;

    const socket = new WebSocket(this.notifyUrl());
    this.socket = socket;

    socket.onopen = () => {
      const reconnected = this.everOpened;
      this.everOpened = true;
      this.reconnectDelayMs = 1000;
      void this.options.onOpen?.(reconnected);
    };

    socket.onmessage = (event) => {
      try {
        void this.options.onMessage?.(JSON.parse(String(event.data)) as NotifyMessage);
      } catch {
        // Ignore malformed notification payloads; REST sync remains authoritative.
      }
    };

    socket.onerror = () => this.reconnect();
    socket.onclose = () => this.reconnect();
  }

  sendOpen(path: string) {
    this.send({ type: "open", path });
  }

  sendCloseFile() {
    this.send({ type: "close_file" });
  }

  close() {
    this.closed = true;
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private reconnect() {
    if (this.closed) return;
    this.socket = null;
    this.options.onClose?.();
    if (this.reconnectTimer !== null) return;

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private notifyUrl(): string {
    const base = this.options.serverUrl.replace(/\/$/, "").replace(/^http:/, "ws:").replace(/^https:/, "wss:");
    return `${base}/api/sync/${encodeURIComponent(this.options.vaultId)}/notify?token=${encodeURIComponent(this.options.token)}`;
  }
}
