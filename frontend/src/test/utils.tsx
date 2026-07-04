import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/AuthContext";

interface RenderOptions {
  route?: string;
}

/**
 * Render a component inside the app's provider stack (Router, React Query,
 * Auth). With no token in localStorage the AuthProvider resolves to an
 * anonymous user without any network call.
 */
export function renderWithProviders(ui: ReactElement, { route = "/" }: RenderOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
      </AuthProvider>
    </QueryClientProvider>,
  );
}
