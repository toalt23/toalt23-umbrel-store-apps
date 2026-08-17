import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

interface BlockchainInfo {
    chain: string;
    blocks: number;
    headers: number;
    verificationprogress: number;
    estimatedheight?: number;
}

export interface NodeStatus {
    connected: boolean;
    chain?: string;
    currentHeight?: number;
    estimatedHeight?: number;
    syncProgress?: number;
    error?: string;
}

@Injectable()
export class NodeService {
    private readonly logger = new Logger(NodeService.name);
    private readonly rpcUrl: string;

    constructor() {
        const host = process.env.ZEBRA_RPC_HOST || 'zebrad';
        const port = process.env.ZEBRA_RPC_PORT || '8232';
        this.rpcUrl = `http://${host}:${port}`;
    }

    async getStatus(): Promise<NodeStatus> {
        try {
            const response = await axios.post(
                this.rpcUrl,
                {
                    jsonrpc: '1.0',
                    id: 'web-ui',
                    method: 'getblockchaininfo',
                    params: [],
                },
                {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 5000,
                },
            );

            const info: BlockchainInfo = response.data.result;

            return {
                connected: true,
                chain: info.chain,
                currentHeight: info.blocks,
                estimatedHeight: info.estimatedheight ?? info.headers,
                syncProgress: Math.round(info.verificationprogress * 10000) / 100,
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            this.logger.warn(`Could not reach zebrad: ${message}`);
            return {
                connected: false,
                error: 'Node nicht erreichbar oder startet noch',
            };
        }
    }
}