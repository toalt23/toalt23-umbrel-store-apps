import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

interface CoinGeckoPriceResponse {
  zcash?: { usd?: number };
}

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cached: { usd: number; fetchedAt: number } | null = null;
  private readonly cacheTtlMs = 60_000;

  async getZecUsdPrice(): Promise<number | undefined> {
    if (this.cached && Date.now() - this.cached.fetchedAt < this.cacheTtlMs) {
      return this.cached.usd;
    }

    try {
      const response = await axios.get<CoinGeckoPriceResponse>(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: { ids: 'zcash', vs_currencies: 'usd' },
          timeout: 10000,
        },
      );

      const usd = response.data.zcash?.usd;
      if (typeof usd !== 'number') {
        throw new Error('Unexpected CoinGecko response shape');
      }

      this.cached = { usd, fetchedAt: Date.now() };
      return usd;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`ZEC/USD price fetch failed: ${message}`);
      // Serve a stale cached price rather than nothing, if we have one.
      return this.cached?.usd;
    }
  }
}
