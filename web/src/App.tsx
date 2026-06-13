import { Routes, Route } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import AuthPage from "./pages/AuthPage";
import VaultListPage from "./pages/VaultListPage";
import VaultWorkspace from "./pages/VaultWorkspace";
import DevicesPage from "./pages/DevicesPage";
import { ToastProvider } from "./components/ui/Toast";

export default function App() {
  const { user, loading, error, signIn, signUp, signOut } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-muted">
        <div className="flex items-center gap-2 text-sm">
          <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
          Loading…
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <AuthPage
        onSignIn={signIn}
        onSignUp={signUp}
        error={error}
        loading={loading}
      />
    );
  }

  return (
    <ToastProvider>
      <Routes>
        <Route
          path="/"
          element={<VaultListPage user={user} onSignOut={signOut} />}
        />
        {/* Device management — Slice 07 */}
        <Route path="/vault/:id/devices" element={<DevicesPage />} />
        {/* Vault workspace — tabbed Obsidian-style editor */}
        <Route path="/vault/:id/*" element={<VaultWorkspace />} />
        <Route
          path="*"
          element={
            <div className="p-8 text-muted">Page not found.</div>
          }
        />
      </Routes>
    </ToastProvider>
  );
}
