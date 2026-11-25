import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { AuthProvider } from './lib/auth';
import { RealtimeProvider } from './lib/realtime';
import { AppearanceProvider } from './lib/theme';
import { ToastProvider } from './lib/toast';
import { I18nRuntime } from './lib/i18n';
import { ApiError } from './lib/api';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        // A permission answer is an answer -- never retry it.
        if (error instanceof ApiError && (error.forbidden || error.status === 401 || error.notFound)) return false;
        return failureCount < 2;
      },
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppearanceProvider>
          <I18nRuntime>
            <ToastProvider>
              <AuthProvider>
                <RealtimeProvider>
                  <App />
                </RealtimeProvider>
              </AuthProvider>
            </ToastProvider>
          </I18nRuntime>
        </AppearanceProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
