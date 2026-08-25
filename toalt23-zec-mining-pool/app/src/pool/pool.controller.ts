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
import { DockerControlService } from './docker-control.service';

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
  ): Promise<{ ok: true; zakuraRestarted: boolean }> {
    if (!body?.minerAddress || typeof body.minerAddress !== 'string') {
      throw new BadRequestException('minerAddress is required');
    }
    try {
      await this.poolConfigService.setConfig(
        body.minerAddress,
        body.coinbaseTag,
      );
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : 'Invalid configuration',
      );
    }
    const zakuraRestarted =
      await this.dockerControlService.restartZakuraContainer();
    return { ok: true, zakuraRestarted };
  }
}
