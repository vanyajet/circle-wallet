'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { CreateUserRequestSchema } from '@circle-wallet/shared';
import { useCreateUser } from '@/lib/queries';
import { errorMessage } from '../query-state';

export function CreateUserForm() {
  const router = useRouter();
  const createUser = useCreateUser();
  const [name, setName] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // Та же zod-схема, что валидирует запрос на бэкенде.
    const parsed = CreateUserRequestSchema.safeParse({ name });
    if (!parsed.success) {
      setValidationError(parsed.error.issues[0]?.message ?? 'Некорректное имя');
      return;
    }
    setValidationError(null);
    createUser.mutate(parsed.data, {
      onSuccess: (user) => router.push(`/users/${user.id}`),
    });
  }

  const error = validationError ?? (createUser.error ? errorMessage(createUser.error) : null);

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <div className="flex-1">
        <input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setValidationError(null);
          }}
          placeholder="Имя пользователя"
          maxLength={100}
          disabled={createUser.isPending}
          className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        />
        {error && <p className="mt-1 text-sm text-red-700">{error}</p>}
      </div>
      <button
        type="submit"
        disabled={createUser.isPending}
        className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {createUser.isPending ? 'Создаём…' : 'Создать пользователя'}
      </button>
    </form>
  );
}
