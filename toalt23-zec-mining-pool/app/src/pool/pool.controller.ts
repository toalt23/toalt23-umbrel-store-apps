import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
} from '@nestjs/common';
import { StratumService, type PoolStatus } from './stratum.service';
import {
  PoolConfigService,
  type PoolConfigStatus,
} from './pool-config.service';
import { DockerControlService } from './docker-control.service';

/** Selectable ranges for the dashboard's per-worker hashrate chart. */
const HASHRATE_HISTORY_RANGE_MS: Record<string, number> = {
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
};

@Controller('api/pool')
export class PoolController {
  constructor(
    private readonly stratumService: StratumService,
    private readonly poolConfigService: PoolConfigService,
    private readonly dockerControlService: DockerControlService,
  ) {}

  @Get('status')
  getStatus(): PoolStatus {
    return this.stratumService.getStatus();
  }

  @Get('config')
  getConfig(): Promise<PoolConfigStatus> {
    return this.poolConfigService.getStatus();
  }

  @Post('config')
  async setConfig(
    @Body() body: { minerAddress?: string; coinbaseTag?: string },
  ): Promise<{ ok: true; changed: boolean; zakuraRestarted: boolean }> {
    if (!body?.minerAddress || typeof body.minerAddress !== 'string') {
      throw new BadRequestException('minerAddress is required');
    }
    let changed: boolean;
    try {
      ({ changed } = await this.poolConfigService.setConfig(
        body.minerAddress,
        body.coinbaseTag,
      ));
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid configuration',
      );
    }
    // Only bounce zakura when the address/tag actually changed — nothing to
    // apply otherwise, and restarting is disruptive (drops peers, current
    // getblocktemplate) for no reason.
    const zakuraRestarted = changed
      ? await this.dockerControlService.restartZakuraContainer()
      : false;
    return { ok: true, changed, zakuraRestarted };
  }

  @Get('worker-hashrate-history')
  getWorkerHashrateHistory(
    @Query('worker') worker?: string,
    @Query('range') range?: string,
  ): { t: number; hr: number }[] {
    if (!worker)
      throw new BadRequestException('worker query param is required');
    const rangeMs = HASHRATE_HISTORY_RANGE_MS[range ?? '15m'];
    if (!rangeMs) {
      throw new BadRequestException('range must be one of 15m, 1h, 8h');
    }
    return this.stratumService.getWorkerHashrateHistory(worker, rangeMs);
  }

  @Post('reset-best-share')
  async resetBestShare(): Promise<{ ok: true }> {
    await this.stratumService.resetBestShare();
    return { ok: true };
  }
}
