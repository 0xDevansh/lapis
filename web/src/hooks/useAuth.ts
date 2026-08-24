import { useState, useEffect, useCallback } from "react";
import * as api from "../api";

const SESSION_HINT_KEY = "lapis-has-session";

interface AuthState {
  user: api.User | null;
  loading: boolean;
  error: string | null;
}

function readSessionHint(): boolean {
  try {
    return localStorage.getItem(SESSION_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

function writeSessionHint(hasSession: boolean) {
  try {
    if (hasSession) localStorage.setItem(SESSION_HINT_KEY, "1");
    else localStorage.removeItem(SESSION_HINT_KEY);
  } catch {
    // ignore
  }
}

export function useAuth() {
  const [state, setState] = useState<AuthState>(() => ({
    user: null,
    // Anonymous visitors skip the loading gate so the landing paints immediately.
    // Returning users (hint set) wait for /get-session to avoid a landing flash.
    loading: readSessionHint(),
    error: null,
  }));

  const refresh = useCallback(async () => {
    setState((s) => ({
      ...s,
      // Only show the full-screen loader when we expect a session.
      loading: s.user != null || readSessionHint(),
      error: null,
    }));
    try {
      const session = await api.getSession();
      const user = session?.user ?? null;
      writeSessionHint(user != null);
      setState({ user, loading: false, error: null });
    } catch (e) {
      setState({
        user: null,
        loading: false,
        error: (e as Error).message,
      });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const user = await api.signIn(email, password);
      writeSessionHint(true);
      setState({ user, loading: false, error: null });
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
      throw e;
    }
  }, []);

  const signUp = useCallback(
    async (name: string, email: string, password: string) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      try {
        const user = await api.signUp(name, email, password);
        writeSessionHint(true);
        setState({ user, loading: false, error: null });
      } catch (e) {
        setState((s) => ({
          ...s,
          loading: false,
          error: (e as Error).message,
        }));
        throw e;
      }
    },
    []
  );

  const signInWithGoogle = useCallback(async (callbackURL = "/") => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      await api.signInWithGoogle(callbackURL);
    } catch (e) {
      setState((s) => ({ ...s, loading: false, error: (e as Error).message }));
      throw e;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
      writeSessionHint(false);
      setState({ user: null, loading: false, error: null });
    } catch (e) {
      setState((s) => ({
        ...s,
        loading: false,
        error: (e as Error).message,
      }));
      throw e;
    }
  }, []);

  return { ...state, signIn, signUp, signInWithGoogle, signOut, refresh };
}
