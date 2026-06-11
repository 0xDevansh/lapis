import { useState, useEffect, useCallback } from "react";
import * as api from "../api";

interface AuthState {
  user: api.User | null;
  loading: boolean;
  error: string | null;
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    const session = await api.getSession();
    setState({ user: session?.user ?? null, loading: false, error: null });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = useCallback(async (email: string, password: string) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const user = await api.signIn(email, password);
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
        await api.signUp(name, email, password);
        // Sign in immediately after registration
        const user = await api.signIn(email, password);
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

  const signOut = useCallback(async () => {
    await api.signOut();
    setState({ user: null, loading: false, error: null });
  }, []);

  return { ...state, signIn, signUp, signOut, refresh };
}
