import { Routes, Route } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import AuthPage from "./pages/AuthPage";
import VaultListPage from "./pages/VaultListPage";
import VaultBrowserPage from "./pages/VaultBrowserPage";
import DevicesPage from "./pages/DevicesPage";

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
      {/* Device management — Slice 07 */}
      <Route path="/vault/:id/devices" element={<DevicesPage />} />
      {/* Vault browser — Slice 02 */}
      <Route path="/vault/:id/*" element={<VaultBrowserPage />} />
      <Route
        path="*"
        element={
          <div style={{ padding: "2rem", color: "#6b6b6b" }}>
            Page not found.
          </div>
        }
      />
    </Routes>
  );
}
