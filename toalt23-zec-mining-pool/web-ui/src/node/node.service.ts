import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { PriceService } from '../price/price.service';

interface BlockchainInfo {
  chain: string;
  blocks: number;
  headers: number;
  difficulty: number;
  verificationprogress: number;
  estimatedheight?: number;
  size_on_disk?: number;
  consensus?: { chaintip: string; nextblock: string };
  upgrades?: Record<
    string,
    { name: string; activationheight: number; status: string }
  >;
}

interface MiningInfo {
  networksolps?: number;
  pooledtx?: number;
}

interface NetworkInfo {
  connections?: number;
  subversion?: string;
}

interface JsonRpcResponse<T> {
  result: T;
  error: { code: number; message: string } | null;
}

export interface NodeStatus {
  connected: boolean;
  chain?: string;
  currentHeight?: number;
  estimatedHeight?: number;
  syncProgress?: number;
  synced?: boolean;
  difficulty?: number;
  networkSolps?: number;
  pooledTx?: number;
  peers?: number;
  version?: string;
  networkUpgrade?: string;
  sizeOnDiskBytes?: number;
  zecUsdPrice?: number;
  updatedAt?: string;
  error?: string;
}

@Injectable()
export class NodeService {
  private readonly logger = new Logger(NodeService.name);
  private readonly rpcUrl: string;

  constructor(private readonly priceService: PriceService) {
    const host = process.env.ZEBRA_RPC_HOST || 'zebrad';
    const port = process.env.ZEBRA_RPC_PORT || '8232';
    this.rpcUrl = `http://${host}:${port}`;
  }

  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await axios.post<JsonRpcResponse<T>>(
      this.rpcUrl,
      {
        jsonrpc: '1.0',
        id: 'web-ui',
        method,
        params,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      },
    );

    if (response.data.error) {
      throw new Error(
        response.data.error.message ?? `RPC error calling ${method}`,
      );
    }

    return response.data.result;
  }

  async getStatus(): Promise<NodeStatus> {
    let chainInfo: BlockchainInfo;
    try {
      chainInfo = await this.rpc<BlockchainInfo>('getblockchaininfo');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Could not reach node: ${message}`);
      return {
        connected: false,
        error: 'Node unreachable or still starting up',
      };
    }

    // Optional extras. Not every zcashd-compat layer implements these RPCs,
    // and the price feed is an external API — each one degrades independently
    // so a single failure doesn't break the whole status.
    const [miningInfo, networkInfo, zecUsdPrice] = await Promise.all([
      this.rpc<MiningInfo>('getmininginfo').catch((error) => {
        this.logger.debug(
          `getmininginfo unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return null;
      }),
      this.rpc<NetworkInfo>('getnetworkinfo').catch((error) => {
        this.logger.debug(
          `getnetworkinfo unavailable: ${error instanceof Error ? error.message : error}`,
        );
        return null;
      }),
      this.priceService.getZecUsdPrice(),
    ]);

    const syncProgress = Math.min(
      100,
      Math.round(chainInfo.verificationprogress * 10000) / 100,
    );
    const branchId = chainInfo.consensus?.chaintip;
    const networkUpgrade = branchId
      ? chainInfo.upgrades?.[branchId]?.name
      : undefined;

    return {
      connected: true,
      chain: chainInfo.chain,
      currentHeight: chainInfo.blocks,
      estimatedHeight: chainInfo.estimatedheight ?? chainInfo.headers,
      syncProgress,
      synced: syncProgress >= 99.995,
      difficulty: chainInfo.difficulty,
      networkSolps: miningInfo?.networksolps,
      pooledTx: miningInfo?.pooledtx,
      peers: networkInfo?.connections,
      version: networkInfo?.subversion,
      networkUpgrade,
      sizeOnDiskBytes: chainInfo.size_on_disk,
      zecUsdPrice,
      updatedAt: new Date().toISOString(),
    };
  }
}
