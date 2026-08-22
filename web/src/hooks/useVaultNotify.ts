/**
 * useVaultNotify — Slice 10.
 *
 * Opens a WebSocket connection to `/api/vaults/:id/notify` and delivers
 * typed server messages. Automatically reconnects with exponential backoff.
 * On reconnect, calls `onReconnect` so the caller can diff the manifest.
 *
 * Usage:
 *   const { presence, sameFileWarning } = useVaultNotify(vaultId, openPath, {
 *     onChange: (msg) => { ... },
 *     onReconnect: () => { refreshManifest(); },
 *   });
 */

import { useEffect, useRef, useState, useCallback } from "react";

export interface ChangeNotification {
  type: "change";
  path: string;
  kind: "put" | "rename" | "delete";
  baseRevision?: number;
  revision?: number;
  patch?: string;
  newPath?: string;
  author?: string;
  ts: string;
}

export interface PresenceEntry {
  identity: string;
  openPath: string | null;
}

export interface PresenceNotification {
  type: "presence";
  sessions: PresenceEntry[];
}

export interface SameFileWarning {
  type: "same_file_warning";
  path: string;
  others: string[];
}

type ServerMessage = ChangeNotification | PresenceNotification | SameFileWarning;

export interface UseVaultNotifyOptions {
  onChange?: (msg: ChangeNotification) => void;
  onReconnect?: () => void;
}

export interface UseVaultNotifyResult {
  connected: boolean;
  presence: PresenceEntry[];
  sameFileWarning: SameFileWarning | null;
}

const INITIAL_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;

export function useVaultNotify(
  vaultId: string | undefined,
  openPath: string | null,
  options: UseVaultNotifyOptions = {}
): UseVaultNotifyResult {
  const [connected, setConnected] = useState(false);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [sameFileWarning, setSameFileWarning] = useState<SameFileWarning | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const openPathRef = useRef(openPath);

  // Keep openPath ref in sync
  useEffect(() => {
    openPathRef.current = openPath;
  }, [openPath]);

  // Keep options ref stable
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const connect = useCallback(() => {
    if (!vaultId || !mountedRef.current) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/vaults/${vaultId}/notify`;

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return ws.close();
      setConnected(true);
      backoffRef.current = INITIAL_BACKOFF;

      // Tell the server which file we have open (if any)
      if (openPathRef.current) {
        ws.send(JSON.stringify({ type: "open", path: openPathRef.current }));
      }
    };

    ws.onmessage = (event) => {
      if (!mountedRef.current) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(event.data as string) as ServerMessage;
      } catch {
        return;
      }

      if (msg.type === "change") {
        optionsRef.current.onChange?.(msg);
      } else if (msg.type === "presence") {
        setPresence(msg.sessions);
      } else if (msg.type === "same_file_warning") {
        setSameFileWarning(msg);
        // Auto-dismiss after 5 seconds
        setTimeout(() => {
          setSameFileWarning((prev) => (prev?.path === msg.path ? null : prev));
        }, 5_000);
      }
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      wsRef.current = null;

      // Reconnect with backoff
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF);
      reconnectTimerRef.current = setTimeout(() => {
        optionsRef.current.onReconnect?.();
        connect();
      }, delay);
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [vaultId]);

  // Notify server when openPath changes
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (openPath) {
      ws.send(JSON.stringify({ type: "open", path: openPath }));
      // Clear any stale same-file warning for a different path
      setSameFileWarning((prev) => (prev && prev.path !== openPath ? null : prev));
    } else {
      ws.send(JSON.stringify({ type: "close_file" }));
      setSameFileWarning(null);
    }
  }, [openPath]);

  // Connect on mount, disconnect on unmount
  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { connected, presence, sameFileWarning };
}
