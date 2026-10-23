'use client';

import { useId, useState, type FormEvent } from 'react';
import type { CreateInternalTransferRequest, UserDetailsDto } from '@circle-wallet/shared';
import { ApiError } from '@/lib/api';
import { shortenHex, UID_RE } from '@/lib/format';
import { useIdempotencyKey } from '@/lib/idempotency';
import { useCreateTransfer, useTokens, useTransferRecipient } from '@/lib/queries';
import { Card } from '../card';
import { ErrorMessage, errorMessage } from '../query-state';
import { inputClass, validateAmount } from './withdrawal-form';

/**
 * Перевод другому пользователю платформы по UID: off-chain, мгновенно и без комиссии.
 * Перевод необратим, поэтому отправка доступна только после подтверждения получателя:
 * бэкенд по UID возвращает маскированное имя, и пользователь видит, кому отправляет.
 */
export function TransferForm({ user }: { user: UserDetailsDto }) {
  const ids = useId();
  const tokensQuery = useTokens();
  const transfer = useCreateTransfer(user.id);
  const idempotency = useIdempotencyKey();

  const [recipientUid, setRecipientUid] = useState('');
  const [selectedToken, setSelectedToken] = useState('');
  const [amount, setAmount] = useState('');
  // Ошибки валидации показываем после первой попытки отправки, а не во время набора.
  const [showErrors, setShowErrors] = useState(false);
  const [successNote, setSuccessNote] = useState<string | null>(null);

  const tokens = tokensQuery.data?.items ?? [];
  // Пока пользователь ничего не выбрал — первый токен из allowlist.
  const token = tokens.find((t) => t.symbol === selectedToken) ?? tokens[0];
  const balance = token ? user.balances.find((b) => b.token === token.symbol) : undefined;
  // Кошелёк Circle переводу не нужен: деньги двигаются только в леджере.
  const disabled = !token || transfer.isPending;

  const uid = recipientUid.trim().toLowerCase();
  const uidValid = UID_RE.test(uid);
  const isSelf = uidValid && uid === user.id.toLowerCase();
  // Получателя ищем, только когда UID введён целиком: частичный ввод не дёргает API.
  const recipient = useTransferRecipient(uidValid && !isSelf ? uid : null);
  const confirmed = recipient.data?.uid === uid ? recipient.data : undefined;

  const trimmedAmount = amount.trim();
  const amountError = token ? validateAmount(trimmedAmount, token.decimals, balance?.available) : null;
  const uidError = !uid
    ? 'Введите UID получателя'
    : !uidValid
      ? 'UID — это идентификатор пользователя вида xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
      : null;

  // Любая правка формы: убираем прошлый результат. Новый ключ идемпотентности получится сам —
  // он привязан к содержимому формы (см. useIdempotencyKey).
  function onEdit() {
    setSuccessNote(null);
    transfer.reset();
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (disabled || !token) return;
    setShowErrors(true);
    if (amountError || uidError || isSelf || !confirmed) return;

    const body: CreateInternalTransferRequest = { token: token.symbol, amount: trimmedAmount, recipientUid: uid };
    const idempotencyKey = idempotency.keyFor(JSON.stringify(body));
    transfer.mutate(
      { body, idempotencyKey },
      {
        onSuccess: (operation) => {
          idempotency.reset();
          setAmount('');
          setRecipientUid('');
          setShowErrors(false);
          setSuccessNote(
            `Переведено ${operation.amount} ${operation.token} → ${confirmed.maskedName} (UID ${shortenHex(confirmed.uid)}).`,
          );
        },
        onError: (error) => {
          // Однозначный отказ (4xx): следующая отправка — новая попытка с новым ключом.
          // При неизвестном исходе ключ сохраняем: повтор тех же данных не создаст дубль.
          if (error instanceof ApiError && !error.isUnknownOutcome) idempotency.reset();
        },
      },
    );
  }

  const unknownOutcome = transfer.error instanceof ApiError && transfer.error.isUnknownOutcome;

  return (
    <Card title="Перевод по UID">
      <p className="mb-3 text-sm text-gray-600">
        Пользователю платформы — мгновенно и без комиссии: перевод проходит внутри сервиса, без блокчейна.
      </p>
      {tokensQuery.isError && (
        <div className="mb-3">
          <ErrorMessage error={tokensQuery.error} onRetry={() => void tokensQuery.refetch()} />
        </div>
      )}

      <form onSubmit={handleSubmit} noValidate>
        <fieldset disabled={disabled} className="flex flex-col gap-3">
          <div>
            <label htmlFor={`${ids}-recipient`} className="mb-1 block text-sm font-medium">
              UID получателя
            </label>
            <input
              id={`${ids}-recipient`}
              value={recipientUid}
              onChange={(event) => {
                setRecipientUid(event.target.value);
                onEdit();
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              className={`${inputClass} font-mono`}
            />
            <RecipientStatus
              isSelf={isSelf}
              confirmedName={confirmed?.maskedName}
              lookup={recipient}
              formatError={showErrors ? uidError : null}
            />
          </div>

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
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {transfer.isPending ? 'Переводим…' : confirmed ? `Перевести → ${confirmed.maskedName}` : 'Перевести'}
            </button>
          </div>
        </fieldset>
      </form>

      {transfer.isError && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          {errorMessage(transfer.error)}
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

function RecipientStatus({
  isSelf,
  confirmedName,
  lookup,
  formatError,
}: {
  isSelf: boolean;
  confirmedName: string | undefined;
  lookup: ReturnType<typeof useTransferRecipient>;
  formatError: string | null;
}) {
  if (isSelf) return <p className="mt-1 text-sm text-red-700">Это ваш UID — перевести самому себе нельзя</p>;
  if (formatError) return <p className="mt-1 text-sm text-red-700">{formatError}</p>;
  if (confirmedName) {
    return (
      <p className="mt-1 text-sm text-green-800">
        Получатель: <span className="font-medium">{confirmedName}</span>
      </p>
    );
  }
  if (lookup.isError) {
    const notFound = lookup.error instanceof ApiError && lookup.error.status === 404;
    return (
      <p className="mt-1 text-sm text-red-700">
        {notFound ? 'Пользователь с таким UID не найден' : errorMessage(lookup.error)}
      </p>
    );
  }
  if (lookup.isFetching) return <p className="mt-1 text-sm text-gray-500">Ищем получателя…</p>;
  return null;
}
