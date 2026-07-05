import React from "react";
import ReactDOM from "react-dom/client";
// Global styles first: base/component layers must bundle before any
// component or page CSS so within-layer cascade order stays correct.
import "@/styles/index.css";
import "@/i18n";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ToastProvider } from "@/components/ui/Toast";
import App from "@/App";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <App />
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
