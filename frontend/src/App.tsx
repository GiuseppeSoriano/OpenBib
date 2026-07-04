import { Routes, Route, Navigate } from "react-router-dom";
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

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="container" style={{ paddingTop: "2rem" }} />;
  return user ? <>{children}</> : <Navigate to="/login" />;
}

/** Authenticated users land on the dashboard; visitors get the search-first landing. */
function HomeRoute() {
  const { user, isLoading } = useAuth();
  if (isLoading) return <div className="container" style={{ paddingTop: "2rem" }} />;
  return user ? <DashboardPage /> : <LandingPage />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route element={<Layout />}>
        {/* Public: search, paper details, graph exploration, public collections */}
        <Route path="/" element={<HomeRoute />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/graph" element={<GraphPage mode="manual" />} />
        <Route path="/graph/:paperKey" element={<GraphPage mode="paper" />} />
        <Route
          path="/graph/collection/:collectionId"
          element={<GraphPage mode="collection" />}
        />
        <Route path="/collections/:id" element={<CollectionDetailPage />} />

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
          path="/graph/library"
          element={
            <RequireAuth>
              <GraphPage mode="library" />
            </RequireAuth>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireAuth>
              <SettingsPage />
            </RequireAuth>
          }
        />
      </Route>
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}
