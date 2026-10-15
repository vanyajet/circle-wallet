import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  IDEMPOTENCY_KEY_HEADER,
  type CreateUserRequest,
  type CreateWithdrawalRequest,
  type OperationDto,
  type OperationsPageDto,
  type OpsOverviewDto,
  type TokensListDto,
  type UserDetailsDto,
  type UserSummaryDto,
  type UsersListDto,
} from '@circle-wallet/shared';
import { apiFetch } from './api';

const OPERATIONS_PAGE_SIZE = 20;

/** Ключи кешей. Префиксы ['user', id] / ['operations', id] инвалидируются SSE-событиями. */
export const queryKeys = {
  tokens: ['tokens'] as const,
  users: ['users'] as const,
  user: (id: string) => ['user', id] as const,
  operations: (id: string) => ['operations', id] as const,
  ops: ['ops'] as const,
};

const userPath = (id: string) => `/users/${encodeURIComponent(id)}`;

export function useTokens() {
  return useQuery({
    queryKey: queryKeys.tokens,
    queryFn: ({ signal }) => apiFetch<TokensListDto>('/tokens', { signal }),
    // Allowlist токенов меняется только конфигурацией бэкенда.
    staleTime: 5 * 60_000,
  });
}

export function useUsers() {
  return useQuery({
    queryKey: queryKeys.users,
    queryFn: ({ signal }) => apiFetch<UsersListDto>('/users', { signal }),
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: queryKeys.user(id),
    queryFn: ({ signal }) => apiFetch<UserDetailsDto>(userPath(id), { signal }),
  });
}

export function useOperations(userId: string) {
  return useInfiniteQuery({
    queryKey: queryKeys.operations(userId),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ limit: String(OPERATIONS_PAGE_SIZE) });
      if (pageParam) params.set('cursor', pageParam);
      return apiFetch<OperationsPageDto>(`${userPath(userId)}/operations?${params.toString()}`, { signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

export function useOpsOverview() {
  return useQuery({
    queryKey: queryKeys.ops,
    queryFn: ({ signal }) => apiFetch<OpsOverviewDto>('/ops/overview', { signal }),
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateUserRequest) =>
      apiFetch<UserSummaryDto>('/users', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.users }),
  });
}

export interface CreateWithdrawalVariables {
  body: CreateWithdrawalRequest;
  idempotencyKey: string;
}

export function useCreateWithdrawal(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ body, idempotencyKey }: CreateWithdrawalVariables) =>
      apiFetch<OperationDto>(`${userPath(userId)}/withdrawals`, {
        method: 'POST',
        headers: { [IDEMPOTENCY_KEY_HEADER]: idempotencyKey },
        body: JSON.stringify(body),
      }),
    // SSE тоже пришлёт invalidate, но обновляем сразу, не дожидаясь события.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.user(userId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.operations(userId) }),
      ]),
  });
}
