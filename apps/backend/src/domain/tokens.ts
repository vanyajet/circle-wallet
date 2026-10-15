import type { DbExecutor } from '../db/client';
import type { Token } from '../db/schema';

/**
 * Allowlist поддерживаемых токенов (таблица app.tokens), закешированный в памяти процесса.
 * Токены — справочник, меняются только миграцией, поэтому загружаем один раз на старте.
 */
export class TokenRegistry {
  private bySymbolMap = new Map<string, Token>();
  private byCircleIdMap = new Map<string, Token>();

  static async load(db: DbExecutor): Promise<TokenRegistry> {
    const registry = new TokenRegistry();
    const rows = await db.selectFrom('app.tokens').selectAll().where('is_enabled', '=', true).orderBy('symbol').execute();
    for (const token of rows) {
      registry.bySymbolMap.set(token.symbol, token);
      registry.byCircleIdMap.set(token.circle_token_id, token);
    }
    return registry;
  }

  all(): Token[] {
    return [...this.bySymbolMap.values()];
  }

  bySymbol(symbol: string): Token | undefined {
    return this.bySymbolMap.get(symbol.toUpperCase());
  }

  byCircleTokenId(tokenId: string | null): Token | undefined {
    return tokenId ? this.byCircleIdMap.get(tokenId) : undefined;
  }

  /** Адреса контрактов токенов — вывод на них запрещён (USDC-контракт в denylist Circle, средства сгорят). */
  contractAddresses(): Set<string> {
    return new Set(this.all().map((t) => t.contract_address));
  }
}
