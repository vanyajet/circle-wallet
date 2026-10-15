import { ApiError } from '@/lib/api';

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Неизвестная ошибка';
}

export function Loading({ text = 'Загрузка…' }: { text?: string }) {
  return <p className="text-sm text-gray-500">{text}</p>;
}

export function ErrorMessage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      <span>{errorMessage(error)}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="underline hover:no-underline">
          Повторить
        </button>
      )}
    </div>
  );
}
