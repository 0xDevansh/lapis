import { Component, Suspense, lazy, type ErrorInfo, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./hooks/useAuth";
import AuthPage from "./pages/AuthPage";
import LandingPage from "./pages/LandingPage";
import { ToastProvider } from "./components/ui/Toast";

const VaultListPage = lazy(() => import("./pages/VaultListPage"));
const VaultWorkspace = lazy(() => import("./pages/VaultWorkspace"));
const DevicesPage = lazy(() => import("./pages/DevicesPage"));

function RouteFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas text-muted">
      <div className="flex items-center gap-2 text-sm">
        <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
        Loading…
      </div>
    </div>
  );
}

class RouteErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Route crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      // Inline colors so a CSS/theme failure still surfaces the crash.
      return (
        <div
          style={{
            display: "flex",
            minHeight: "100vh",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
            padding: 24,
            background: "#111820",
            color: "#e8eef4",
            textAlign: "center",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <p style={{ margin: 0, fontSize: 14, color: "#e06c75" }}>
            Something went wrong loading this page.
          </p>
          <pre
            style={{
              maxWidth: 512,
              overflow: "auto",
              margin: 0,
              padding: 12,
              borderRadius: 6,
              border: "1px solid #243040",
              background: "#172029",
              color: "#8b9aab",
              fontSize: 11,
              textAlign: "left",
            }}
          >
            {this.state.error.message}
          </pre>
          <button
            type="button"
            style={{
              border: "none",
              borderRadius: 6,
              padding: "8px 12px",
              background: "#61afef",
              color: "#1a1d23",
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
            }}
            onClick={() => {
              this.setState({ error: null });
              window.location.assign("/");
            }}
          >
            Back to vaults
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function AppRoutes() {
  const { user, loading, error, signIn, signUp, signInWithGoogle, signOut } = useAuth();

  if (loading) {
    return <RouteFallback />;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route
          path="/auth"
          element={
            <AuthPage
              onSignIn={signIn}
              onSignUp={signUp}
              onSignInWithGoogle={signInWithGoogle}
              error={error}
              loading={loading}
            />
          }
        />
        <Route
          path="/invites/:token"
          element={<Navigate to="/auth?mode=signin" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    );
  }

  return (
    <RouteErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
        <Routes>
          <Route
            path="/"
            element={<VaultListPage user={user} onSignOut={signOut} />}
          />
          <Route path="/auth" element={<Navigate to="/" replace />} />
          <Route path="/vault/:id/devices" element={<DevicesPage />} />
          <Route path="/vault/:id/*" element={<VaultWorkspace />} />
          <Route
            path="*"
            element={<div className="p-8 text-muted">Page not found.</div>}
          />
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppRoutes />
    </ToastProvider>
  );
}
