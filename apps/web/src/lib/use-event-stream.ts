import { useEffect, useRef } from 'react';
import type { SseEventName } from '@circle-wallet/shared';
import { apiUrl } from './api';

const EVENT_NAMES: readonly SseEventName[] = ['invalidate', 'resync', 'ready'];

export type EventStreamHandler = (name: SseEventName, data: unknown) => void;

function parseData(raw: unknown): unknown {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Подписка на SSE-стрим API. События — только сигнал «данные устарели»: сами данные перечитываются по REST
 * (invalidateQueries), поэтому пропущенное событие безвредно, а `ready` при каждом (пере)подключении
 * даёт полный refetch.
 *
 * Переподключение — встроенное в EventSource (без собственного polling).
 * `path = null` — не подключаться (например, пока не известно, что пользователь существует).
 */
export function useEventStream(path: string | null, onEvent: EventStreamHandler): void {
  // Последний колбэк держим в ref, чтобы соединение не пересоздавалось на каждом рендере.
  const handlerRef = useRef(onEvent);
  useEffect(() => {
    handlerRef.current = onEvent;
  });

  useEffect(() => {
    if (path === null) return;
    const source = new EventSource(apiUrl(path));
    // Именованные события (`event: invalidate`) не попадают в onmessage — слушаем каждое явно.
    for (const name of EVENT_NAMES) {
      source.addEventListener(name, (event) => {
        handlerRef.current(name, parseData((event as MessageEvent).data));
      });
    }
    return () => source.close();
  }, [path]);
}
