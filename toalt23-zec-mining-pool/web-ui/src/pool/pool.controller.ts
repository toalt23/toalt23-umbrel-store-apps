import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
} from '@nestjs/common';
import { StratumService, type PoolStatus } from './stratum.service';
import {
  PoolConfigService,
  type PoolConfigStatus,
} from './pool-config.service';

@Controller('api/pool')
export class PoolController {
  constructor(
    private readonly stratumService: StratumService,
    private readonly poolConfigService: PoolConfigService,
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
    @Body() body: { minerAddress?: string },
  ): Promise<{ ok: true; restartRequired: true }> {
    if (!body?.minerAddress || typeof body.minerAddress !== 'string') {
      throw new BadRequestException('minerAddress is required');
    }
    try {
      await this.poolConfigService.setMinerAddress(body.minerAddress);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid address',
      );
    }
    return { ok: true, restartRequired: true };
  }
}
