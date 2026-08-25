import { Module } from '@nestjs/common';
import { PriceModule } from '../price/price.module';
import { NodeController } from './node.controller';
import { NodeService } from './node.service';

@Module({
  imports: [PriceModule],
  controllers: [NodeController],
  providers: [NodeService],
  exports: [NodeService],
})
export class NodeModule {}
