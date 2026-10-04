import { Routes, Route, Navigate, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import { useAuth } from "@/contexts/AuthContext";
import Layout from "@/components/Layout";
import LoginPage from "@/pages/LoginPage";
import RegisterPage from "@/pages/RegisterPage";
import LandingPage from "@/pages/LandingPage";
import DashboardPage from "@/pages/DashboardPage";
import SearchPage from "@/pages/SearchPage";
import CollectionsPage from "@/pages/CollectionsPage";
import CollectionDetailPage from "@/pages/CollectionDetailPage";
import LibraryPage from "@/pages/LibraryPage";
import GraphPage from "@/pages/GraphPage";
import SettingsPage from "@/pages/SettingsPage";
import LegalPage from "@/pages/LegalPage";
import { CheckEmailPage, ConfirmEmailPage, ForgotPasswordPage, LegalReviewPage, ResetPasswordPage, VerifyEmailPage } from "@/pages/AccountLifecyclePages";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <div className="container auth-loading" />;
  if (!user) return <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search + location.hash }} />;
  if (user.legal_acceptance_required) return <Navigate to="/legal-review" />;
  return <>{children}</>;
}

function RequireBasicAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <div className="container auth-loading" />;
  return user ? <>{children}</> : <Navigate to="/login" replace state={{ returnTo: location.pathname + location.search + location.hash }} />;
}

/** Authenticated users land on the dashboard; visitors get the search-first landing. */
function HomeRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="container auth-loading" />;
  if (user?.legal_acceptance_required) return <Navigate to="/legal-review" />;
  return user ? <DashboardPage /> : <LandingPage />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/check-email" element={<CheckEmailPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/confirm-email" element={<ConfirmEmailPage />} />
      <Route path="/legal-review" element={<RequireBasicAuth><LegalReviewPage /></RequireBasicAuth>} />
      <Route element={<Layout />}>
        {/* Public: search, paper details, collections with read links */}
        <Route path="/" element={<HomeRoute />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/collections/:id" element={<CollectionDetailPage />} />
        <Route path="/privacy" element={<LegalPage kind="privacy" />} />
        <Route path="/terms" element={<LegalPage kind="terms" />} />

        {/* Account-scoped */}
        <Route
          path="/collections"
          element={
            <RequireAuth>
              <CollectionsPage />
            </RequireAuth>
          }
        />
        <Route
          path="/library"
          element={
            <RequireAuth>
              <LibraryPage />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireBasicAuth>
              <SettingsPage />
            </RequireBasicAuth>
          }
        />
      </Route>
      {/* The citation graph is a full-screen page: no sidebar, top bar or footer. */}
      <Route element={<Layout bare />}>
        <Route path="/graph" element={<GraphPage mode="manual" />} />
        <Route path="/graph/:paperKey" element={<GraphPage mode="paper" />} />
        <Route
          path="/graph/collection/:collectionId"
          element={<GraphPage mode="collection" />}
        />
        <Route
          path="/graph/library"
          element={
            <RequireAuth>
              <GraphPage mode="library" />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
