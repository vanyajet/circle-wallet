'use client';

import { useEffect, useState } from 'react';

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyButton({ value, label = 'Копировать' }: { value: string; label?: string }) {
  const [state, setState] = useState<CopyState>('idle');

  useEffect(() => {
    if (state === 'idle') return;
    const timer = setTimeout(() => setState('idle'), 1500);
    return () => clearTimeout(timer);
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      setState('failed');
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Скопировать ${value}`}
      className="rounded border border-gray-300 px-1.5 py-0.5 text-xs text-gray-600 hover:bg-gray-100"
    >
      {state === 'copied' ? 'Скопировано' : state === 'failed' ? 'Не удалось' : label}
    </button>
  );
}
