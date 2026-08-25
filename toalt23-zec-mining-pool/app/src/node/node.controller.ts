import { Controller, Get } from '@nestjs/common';
import { NodeService, NodeStatus } from './node.service';

@Controller('api/node')
export class NodeController {
  constructor(private readonly nodeService: NodeService) {}

  @Get('status')
  async getStatus(): Promise<NodeStatus> {
    return this.nodeService.getStatus();
  }
}
