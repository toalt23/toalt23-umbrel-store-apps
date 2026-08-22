import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

interface CoinGeckoPriceResponse {
  zcash?: { eur?: number };
}

@Injectable()
export class PriceService {
  private readonly logger = new Logger(PriceService.name);
  private cached: { eur: number; fetchedAt: number } | null = null;
  private readonly cacheTtlMs = 60_000;

  async getZecEurPrice(): Promise<number | undefined> {
    if (this.cached && Date.now() - this.cached.fetchedAt < this.cacheTtlMs) {
      return this.cached.eur;
    }

    try {
      const response = await axios.get<CoinGeckoPriceResponse>(
        'https://api.coingecko.com/api/v3/simple/price',
        {
          params: { ids: 'zcash', vs_currencies: 'eur' },
          timeout: 10000,
        },
      );

      const eur = response.data.zcash?.eur;
      if (typeof eur !== 'number') {
        throw new Error('Unexpected CoinGecko response shape');
      }

      this.cached = { eur, fetchedAt: Date.now() };
      return eur;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.debug(`ZEC/EUR price fetch failed: ${message}`);
      // Serve a stale cached price rather than nothing, if we have one.
      return this.cached?.eur;
    }
  }
}
