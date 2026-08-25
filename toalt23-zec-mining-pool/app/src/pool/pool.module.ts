import { Module } from '@nestjs/common';
import { NodeModule } from '../node/node.module';
import { PoolController } from './pool.controller';
import { StratumService } from './stratum.service';
import { PoolConfigService } from './pool-config.service';

@Module({
  imports: [NodeModule],
  controllers: [PoolController],
  providers: [StratumService, PoolConfigService],
})
export class PoolModule {}
