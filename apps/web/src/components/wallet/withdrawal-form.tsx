'use client';

import { useId, useState, type FormEvent } from 'react';
import {
  isValidAmount,
  parseUnits,
  type CreateWithdrawalRequest,
  type UserDetailsDto,
} from '@circle-wallet/shared';
import { ApiError } from '@/lib/api';
import { ADDRESS_RE } from '@/lib/format';
import { useIdempotencyKey } from '@/lib/idempotency';
import { useCreateWithdrawal, useTokens } from '@/lib/queries';
import { Card } from '../card';
import { ErrorMessage, errorMessage } from '../query-state';

export function validateAmount(amount: string, decimals: number, available: string | undefined): string | null {
  if (!amount) return 'Введите сумму';
  if (!isValidAmount(amount, decimals)) {
    return `Введите положительное число через точку, не более ${decimals} знаков после точки`;
  }
  if (available !== undefined) {
    try {
      // Сравнение в минимальных единицах (bigint), без float. Окончательно баланс проверит бэкенд.
      if (parseUnits(amount, decimals) > parseUnits(available, decimals)) {
        return `Недостаточно средств: доступно ${available}`;
      }
    } catch {
      // Баланс в неожиданном формате — оставляем проверку бэкенду.
    }
  }
  return null;
}

function validateDestination(destination: string, ownAddress: string | null): string | null {
  if (!destination) return 'Введите адрес получателя';
  if (!ADDRESS_RE.test(destination)) return 'Адрес должен начинаться с 0x и содержать 40 hex-символов';
  if (ownAddress && destination.toLowerCase() === ownAddress.toLowerCase()) {
    return 'Нельзя вывести на собственный deposit-адрес';
  }
  return null;
}

export const inputClass =
  'w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none disabled:bg-gray-100';

export function WithdrawalForm({ user }: { user: UserDetailsDto }) {
  const ids = useId();
  const tokensQuery = useTokens();
  const withdrawal = useCreateWithdrawal(user.id);
  const idempotency = useIdempotencyKey();

  const [selectedToken, setSelectedToken] = useState('');
  const [amount, setAmount] = useState('');
  const [destination, setDestination] = useState('');
  // Ошибки валидации показываем после первой попытки отправки, а не во время набора.
  const [showErrors, setShowErrors] = useState(false);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  const tokens = tokensQuery.data?.items ?? [];
  // Пока пользователь ничего не выбрал — первый токен из allowlist.
  const token = tokens.find((t) => t.symbol === selectedToken) ?? tokens[0];
  const balance = token ? user.balances.find((b) => b.token === token.symbol) : undefined;
  const walletReady = user.walletStatus === 'ACTIVE';
  const disabled = !walletReady || !token || withdrawal.isPending;

  const trimmedAmount = amount.trim();
  const trimmedDestination = destination.trim();
  const amountError = token ? validateAmount(trimmedAmount, token.decimals, balance?.available) : null;
  const destinationError = validateDestination(trimmedDestination, user.depositAddress);

  // Любая правка формы: убираем прошлый результат. Новый ключ идемпотентности получится сам —
  // он привязан к содержимому формы (см. useIdempotencyKey).
  function onEdit() {
    setSuccessNote(null);
    withdrawal.reset();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabled || !token) return;
    setShowErrors(true);
    if (amountError || destinationError) return;

    const body: CreateWithdrawalRequest = {
      token: token.symbol,
      amount: trimmedAmount,
      destinationAddress: trimmedDestination,
    };
    const idempotencyKey = idempotency.keyFor(JSON.stringify(body));
    withdrawal.mutate(
      { body, idempotencyKey },
      {
        onSuccess: (operation) => {
          idempotency.reset();
          setAmount('');
          setDestination('');
          setShowErrors(false);
          setSuccessNote(`Вывод ${operation.amount} ${operation.token} создан — статус смотрите в истории операций.`);
        },
        onError: (error) => {
          // Однозначный отказ (4xx): следующая отправка — новая попытка с новым ключом.
          // При неизвестном исходе ключ сохраняем: повтор тех же данных не создаст дубль.
          if (error instanceof ApiError && !error.isUnknownOutcome) idempotency.reset();
        },
      },
    );
  }

  const unknownOutcome = withdrawal.error instanceof ApiError && withdrawal.error.isUnknownOutcome;

  return (
    <Card title="Вывод средств">
      {!walletReady && (
        <p className="mb-3 text-sm text-amber-700">Кошелёк ещё создаётся — вывод станет доступен после активации.</p>
      )}
      {tokensQuery.isError && (
        <div className="mb-3">
          <ErrorMessage error={tokensQuery.error} onRetry={() => void tokensQuery.refetch()} />
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset disabled={disabled} className="flex flex-col gap-3">
          <div>
            <label htmlFor={`${ids}-token`} className="mb-1 block text-sm font-medium">
              Токен
            </label>
            <select
              id={`${ids}-token`}
              value={token?.symbol ?? ''}
              onChange={(event) => {
                setSelectedToken(event.target.value);
                onEdit();
              }}
              className={inputClass}
            >
              {tokens.length === 0 && <option value="">{tokensQuery.isPending ? 'Загрузка…' : 'Нет токенов'}</option>}
              {tokens.map((t) => (
                <option key={t.symbol} value={t.symbol}>
                  {t.symbol}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor={`${ids}-amount`} className="mb-1 block text-sm font-medium">
              Сумма
            </label>
            <div className="flex gap-2">
              <input
                id={`${ids}-amount`}
                value={amount}
                onChange={(event) => {
                  // Русская раскладка даёт запятую — API ждёт точку.
                  setAmount(event.target.value.replace(',', '.'));
                  onEdit();
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                className={`${inputClass} tabular-nums`}
              />
              <button
                type="button"
                disabled={!balance}
                onClick={() => {
                  // Копируем строку как есть — никакой арифметики с плавающей точкой.
                  setAmount(balance?.available ?? '');
                  onEdit();
                }}
                className="rounded border border-gray-300 px-3 py-2 text-sm hover:bg-gray-100 disabled:opacity-50"
              >
                Макс
              </button>
            </div>
            {token && (
              <p className="mt-1 text-xs text-gray-500">
                Доступно: {balance?.available ?? '0'} {token.symbol}
              </p>
            )}
            {showErrors && amountError && <p className="mt-1 text-sm text-red-700">{amountError}</p>}
          </div>

          <div>
            <label htmlFor={`${ids}-destination`} className="mb-1 block text-sm font-medium">
              Адрес получателя
            </label>
            <input
              id={`${ids}-destination`}
              value={destination}
              onChange={(event) => {
                setDestination(event.target.value);
                onEdit();
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="0x…"
              className={`${inputClass} font-mono`}
            />
            {showErrors && destinationError && <p className="mt-1 text-sm text-red-700">{destinationError}</p>}
          </div>

          <div>
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {withdrawal.isPending ? 'Отправляем…' : 'Вывести'}
            </button>
          </div>
        </fieldset>
      </form>

      {withdrawal.isError && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage(withdrawal.error)}
          {unknownOutcome && (
            <div className="mt-1 text-xs">
              Исход запроса неизвестен. Повторная отправка тех же данных безопасна — дубля не будет.
            </div>
          )}
        </div>
      )}
      {successNote && (
        <p className="mt-3 rounded border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800">
          {successNote}
        </p>
      )}
    </Card>
  );
}
