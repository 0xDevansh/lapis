import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import AuthPage from "./pages/AuthPage";
import VaultListPage from "./pages/VaultListPage";
import VaultBrowserPage from "./pages/VaultBrowserPage";

export default function App() {
  const { user, loading, error, signIn, signUp, signOut } = useAuth();

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          color: "#6b6b6b",
        }}
      >
        Loading...
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
    <Routes>
      <Route
        path="/"
        element={<VaultListPage user={user} onSignOut={signOut} />}
      />
      {/* Vault browser — Slice 02 */}
      <Route path="/vault/:id/*" element={<VaultBrowserPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
