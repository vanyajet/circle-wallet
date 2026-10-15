'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from '@/lib/api';

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Свежесть данных обеспечивают SSE-инвалидации, поэтому короткий staleTime достаточен.
        staleTime: 5_000,
        // 4xx (например, 404) повторять бессмысленно; сеть и 5xx — пару раз.
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return failureCount < 2;
        },
      },
    },
  });
}

export function Providers({ children }: { children: ReactNode }) {
  // Один клиент на жизнь вкладки (не пересоздаётся при ре-рендерах).
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
