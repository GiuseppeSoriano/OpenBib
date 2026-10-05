import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider } from "@/contexts/AuthContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { ToastProvider } from "@/components/ui/Toast";

interface RenderOptions {
  route?: string;
}

/**
 * Render a component inside the app's provider stack (Router, React Query,
 * Theme, Toast, Auth). Cookie refresh is mocked by test/auth-mock; no
 * authentication test uses Web Storage.
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
      <ThemeProvider>
        <ToastProvider>
          <AuthProvider>
            <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
          </AuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

type MediaListener = (event: MediaQueryListEvent) => void;

const originalMatchMedia = window.matchMedia;

/**
 * Replace `window.matchMedia` so `matches(query)` decides every query.
 * `set()` swaps the predicate and notifies listeners whose result changed
 * (a live resize). Undo it with `restoreMatchMedia()` in an `afterEach`.
 */
export function mockMatchMedia(matches: (query: string) => boolean) {
  let predicate = matches;
  const lists: { query: string; matches: boolean; listeners: Set<MediaListener> }[] = [];
  window.matchMedia = (query: string) => {
    const entry = { query, matches: predicate(query), listeners: new Set<MediaListener>() };
    lists.push(entry);
    const list = {
      get matches() {
        return predicate(query);
      },
      media: query,
      onchange: null,
      addListener: (listener: MediaListener) => entry.listeners.add(listener),
      removeListener: (listener: MediaListener) => entry.listeners.delete(listener),
      addEventListener: (_type: string, listener: MediaListener) => entry.listeners.add(listener),
      removeEventListener: (_type: string, listener: MediaListener) => entry.listeners.delete(listener),
      dispatchEvent: () => false,
    };
    return list as unknown as MediaQueryList;
  };
  return {
    set(next: (query: string) => boolean) {
      predicate = next;
      for (const entry of lists) {
        const now = predicate(entry.query);
        if (now === entry.matches) continue;
        entry.matches = now;
        for (const listener of entry.listeners) listener({ matches: now, media: entry.query } as MediaQueryListEvent);
      }
    },
  };
}

export function restoreMatchMedia() {
  window.matchMedia = originalMatchMedia;
}
