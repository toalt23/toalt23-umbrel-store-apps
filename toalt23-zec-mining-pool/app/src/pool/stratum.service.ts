import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import * as net from 'net';
import * as crypto from 'crypto';
import { NodeService } from '../node/node.service';
import { BlockTemplateResult } from './types';
import {
  DEFAULT_PRESET_KEY,
  clampShareTarget,
  diff1TargetFrom,
  difficultyFromHash,
  estimateHashrate,
  resolvePreset,
  shareDifficultyForPreset,
  shareDifficultyToTarget,
} from './difficulty';
import {
  HeaderFields,
  assembleBlockHex,
  assembleFullHeader,
  assembleHeaderWithoutSolution,
  bigIntToTargetHex,
  doubleSha256,
  extractHeaderFields,
  headerHashToBigInt,
  hexToBigInt,
  readCompactSize,
  uint32LE,
} from './block-header';
import {
  isEquihashVerifyAvailable,
  verifyEquihashSolution,
} from './equihash-verify';
import { loadPoolStats, savePoolStats } from './pool-stats-store';

interface Job {
  id: string;
  template: BlockTemplateResult;
  fields: HeaderFields;
  networkTarget: bigint;
  diff1Target: bigint;
  createdAt: number;
  /** Dedupe key (`${nonce2Hex}:${timeHex}`) -> seen, per job. */
  seen: Set<string>;
}

interface ShareSample {
  at: number;
  difficulty: number;
}

interface WorkerConnection {
  socket: net.Socket;
  sessionId: string;
  nonce1: Buffer;
  subscribed: boolean;
  workerName?: string;
  presetKey: string;
  shareDifficulty: number;
  currentTarget: bigint;
  buffer: string;
  connectedAt: number;
  lastShareAt?: number;
  acceptedShares: number;
  rejectedShares: number;
  recentShareDifficulties: ShareSample[];
  /** Highest difficulty this worker has achieved this session — resets on reconnect, unlike the pool-wide record below. */
  bestShareDifficulty: number;
}

export interface PoolWorkerStatus {
  workerName: string;
  presetKey: string;
  shareDifficulty: number;
  acceptedShares: number;
  rejectedShares: number;
  estimatedHashrateSolPerSecond: number;
  bestShareDifficulty: number;
  connectedAt: string;
  lastShareAt?: string;
}

export interface PoolStatus {
  stratumPort: number;
  equihashVerifyAvailable: boolean;
  blocksFound: number;
  lastBlockFoundAt?: string;
  lastBlockFoundHeight?: number;
  currentJobId?: string;
  currentHeight?: number;
  /** Current network difficulty (relative to powLimit=1) — lets the UI show bestShareDifficultyEver as "% of a block". */
  networkDifficulty?: number;
  /** All-time best share difficulty across all workers, persisted across restarts (see pool-stats-store.ts). */
  bestShareDifficultyEver: number;
  bestShareDifficultyWorker?: string;
  bestShareDifficultyAt?: string;
  lastTemplateFetchedAt?: string;
  lastTemplateError?: string;
  connectedWorkers: PoolWorkerStatus[];
}

const SHARE_WINDOW_MS = 10 * 60 * 1000;
const MAX_JOBS_RETAINED = 6;
const MAX_LINE_LENGTH = 65536;

// Error codes per ZIP-301 ("Zcash Stratum Protocol").
const ERR_OTHER = 20;
const ERR_JOB_NOT_FOUND = 21;
const ERR_DUPLICATE_SHARE = 22;
const ERR_LOW_DIFFICULTY_SHARE = 23;
const ERR_UNAUTHORIZED_WORKER = 24;
const ERR_NOT_SUBSCRIBED = 25;

@Injectable()
export class StratumService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StratumService.name);
  private readonly port = Number(process.env.POOL_STRATUM_PORT ?? 3333);
  private readonly pollIntervalMs = Number(
    process.env.POOL_POLL_INTERVAL_MS ?? 15000,
  );

  private server?: net.Server;
  private pollTimer?: NodeJS.Timeout;
  private readonly connections = new Map<string, WorkerConnection>();
  private readonly jobs = new Map<string, Job>();
  private currentJob: Job | null = null;
  private jobCounter = 0;
  private nonce1Counter = 0;
  private lastKnownDifficulty?: number;
  private polling = false;

  private blocksFound = 0;
  private lastBlockFoundAt?: Date;
  private lastBlockFoundHeight?: number;
  private bestShareDifficultyEver = 0;
  private bestShareDifficultyWorker?: string;
  private bestShareDifficultyAt?: Date;
  private lastTemplateFetchedAt?: Date;
  private lastTemplateError?: string;

  constructor(private readonly nodeService: NodeService) {}

  async onModuleInit() {
    if (!isEquihashVerifyAvailable()) {
      this.logger.error(
        'Starting WITHOUT Equihash solution verification — shares are only checked against the target hash, ' +
          'not cryptographically. Check why equihash-verify-wasm failed to load (see the EquihashVerify logger) before relying on this.',
      );
    }

    const persisted = await loadPoolStats();
    this.blocksFound = persisted.blocksFound;
    this.lastBlockFoundAt = persisted.lastBlockFoundAt
      ? new Date(persisted.lastBlockFoundAt)
      : undefined;
    this.lastBlockFoundHeight = persisted.lastBlockFoundHeight;
    this.bestShareDifficultyEver = persisted.bestShareDifficultyEver;
    this.bestShareDifficultyWorker = persisted.bestShareDifficultyWorker;
    this.bestShareDifficultyAt = persisted.bestShareDifficultyAt
      ? new Date(persisted.bestShareDifficultyAt)
      : undefined;

    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on('error', (err) =>
      this.logger.error(`Stratum server error: ${err.message}`),
    );
    this.server.listen(this.port, () =>
      this.logger.log(`Stratum server listening on port ${this.port}`),
    );

    void this.pollTemplate();
    this.pollTimer = setInterval(
      () => void this.pollTemplate(),
      this.pollIntervalMs,
    );
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.server?.close();
    for (const conn of this.connections.values()) conn.socket.destroy();
  }

  getStatus(): PoolStatus {
    const now = Date.now();
    return {
      stratumPort: this.port,
      equihashVerifyAvailable: isEquihashVerifyAvailable(),
      blocksFound: this.blocksFound,
      lastBlockFoundAt: this.lastBlockFoundAt?.toISOString(),
      lastBlockFoundHeight: this.lastBlockFoundHeight,
      currentJobId: this.currentJob?.id,
      currentHeight: this.currentJob?.template.height,
      networkDifficulty: this.lastKnownDifficulty,
      bestShareDifficultyEver: this.bestShareDifficultyEver,
      bestShareDifficultyWorker: this.bestShareDifficultyWorker,
      bestShareDifficultyAt: this.bestShareDifficultyAt?.toISOString(),
      lastTemplateFetchedAt: this.lastTemplateFetchedAt?.toISOString(),
      lastTemplateError: this.lastTemplateError,
      connectedWorkers: [...this.connections.values()]
        .filter(
          (c): c is WorkerConnection & { workerName: string } => !!c.workerName,
        )
        .map((c) => {
          const windowSeconds = Math.min(
            (now - c.connectedAt) / 1000,
            SHARE_WINDOW_MS / 1000,
          );
          const totalDifficulty = c.recentShareDifficulties.reduce(
            (sum, s) => sum + s.difficulty,
            0,
          );
          return {
            workerName: c.workerName,
            presetKey: c.presetKey,
            shareDifficulty: c.shareDifficulty,
            acceptedShares: c.acceptedShares,
            rejectedShares: c.rejectedShares,
            estimatedHashrateSolPerSecond: estimateHashrate(
              totalDifficulty,
              windowSeconds,
            ),
            bestShareDifficulty: c.bestShareDifficulty,
            connectedAt: new Date(c.connectedAt).toISOString(),
            lastShareAt: c.lastShareAt
              ? new Date(c.lastShareAt).toISOString()
              : undefined,
          };
        }),
    };
  }

  // ---------------------------------------------------------------------
  // Template polling / job broadcast
  // ---------------------------------------------------------------------

  private async pollTemplate() {
    if (this.polling) return; // don't overlap if a previous call is slow
    this.polling = true;
    try {
      let template: BlockTemplateResult;
      try {
        template = await this.nodeService.getBlockTemplate();
      } catch (error) {
        this.lastTemplateError =
          error instanceof Error ? error.message : String(error);
        this.logger.debug(`getblocktemplate failed: ${this.lastTemplateError}`);
        return;
      }
      this.lastTemplateError = undefined;
      this.lastTemplateFetchedAt = new Date();

      const prevJob = this.currentJob;
      const changed =
        !prevJob ||
        prevJob.template.previousblockhash !== template.previousblockhash ||
        prevJob.template.defaultroots?.merkleroot !==
          template.defaultroots?.merkleroot;
      if (!changed) return;

      const cleanJobs =
        !prevJob ||
        prevJob.template.previousblockhash !== template.previousblockhash;

      let difficulty = this.lastKnownDifficulty;
      try {
        difficulty = await this.nodeService.getNetworkDifficulty();
        this.lastKnownDifficulty = difficulty;
      } catch (error) {
        this.logger.warn(
          `getblockchaininfo (needed for share-difficulty math) failed: ${error instanceof Error ? error.message : error}`,
        );
        if (difficulty == null) return; // no reference point at all yet, skip this round
      }

      const networkTarget = hexToBigInt(template.target);
      const diff1Target = diff1TargetFrom(networkTarget, difficulty);
      let fields: HeaderFields;
      try {
        fields = extractHeaderFields(template);
      } catch (error) {
        this.lastTemplateError =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Could not build header fields from template: ${this.lastTemplateError}`,
        );
        return;
      }

      const jobId = (++this.jobCounter).toString(16);
      const job: Job = {
        id: jobId,
        template,
        fields,
        networkTarget,
        diff1Target,
        createdAt: Date.now(),
        seen: new Set(),
      };
      this.currentJob = job;
      this.jobs.set(jobId, job);
      this.pruneOldJobs();

      this.logger.log(
        `New job ${jobId} — height ${template.height}, ${this.connections.size} connection(s), clean_jobs=${cleanJobs}`,
      );

      for (const conn of this.connections.values()) {
        if (!conn.subscribed || !conn.workerName) continue;
        this.sendTargetForConnection(conn);
        this.sendJob(conn, job, cleanJobs);
      }
    } finally {
      this.polling = false;
    }
  }

  private pruneOldJobs() {
    const ids = [...this.jobs.keys()];
    if (ids.length <= MAX_JOBS_RETAINED) return;
    for (const id of ids.slice(0, ids.length - MAX_JOBS_RETAINED))
      this.jobs.delete(id);
  }

  // ---------------------------------------------------------------------
  // TCP / line framing
  // ---------------------------------------------------------------------

  private handleConnection(socket: net.Socket) {
    const sessionId = crypto.randomBytes(8).toString('hex');
    const nonce1 = uint32LE(this.nonce1Counter++);
    const defaultPreset = resolvePreset(DEFAULT_PRESET_KEY);

    const conn: WorkerConnection = {
      socket,
      sessionId,
      nonce1,
      subscribed: false,
      presetKey: DEFAULT_PRESET_KEY,
      shareDifficulty: shareDifficultyForPreset(defaultPreset),
      currentTarget: 0n,
      buffer: '',
      connectedAt: Date.now(),
      acceptedShares: 0,
      rejectedShares: 0,
      recentShareDifficulties: [],
      bestShareDifficulty: 0,
    };
    this.connections.set(sessionId, conn);
    this.logger.log(
      `Miner connected: ${socket.remoteAddress}:${socket.remotePort} (session ${sessionId})`,
    );

    socket.setEncoding('utf8');
    socket.setKeepAlive(true);
    socket.on('data', (chunk: string) => this.handleData(conn, chunk));
    socket.on('close', () => {
      this.connections.delete(sessionId);
      this.logger.log(`Miner disconnected: session ${sessionId}`);
    });
    socket.on('error', (err) =>
      this.logger.debug(`Socket error (session ${sessionId}): ${err.message}`),
    );
  }

  private handleData(conn: WorkerConnection, chunk: string) {
    conn.buffer += chunk;
    let idx: number;
    while ((idx = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, idx).trim();
      conn.buffer = conn.buffer.slice(idx + 1);
      if (line.length > 0) this.handleLine(conn, line);
    }
    if (conn.buffer.length > MAX_LINE_LENGTH) {
      this.logger.warn(
        `Session ${conn.sessionId} sent an oversized line, disconnecting`,
      );
      conn.socket.destroy();
    }
  }

  private handleLine(conn: WorkerConnection, line: string) {
    let message: { id?: unknown; method?: string; params?: unknown[] };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      this.logger.debug(`Bad JSON from session ${conn.sessionId}: ${line}`);
      return;
    }
    const { id, method, params = [] } = message;
    try {
      switch (method) {
        case 'mining.subscribe':
          this.handleSubscribe(conn, id);
          break;
        case 'mining.authorize':
          this.handleAuthorize(conn, id, params);
          break;
        case 'mining.submit':
          this.handleSubmit(conn, id, params);
          break;
        case 'mining.suggest_target':
          // Optional per ZIP-301 — acknowledged, but we keep our own preset-derived target.
          this.sendTargetForConnection(conn);
          break;
        default:
          this.sendError(
            conn,
            id,
            ERR_OTHER,
            `Unknown method: ${String(method)}`,
          );
      }
    } catch (error) {
      this.logger.error(
        `Error handling ${String(method)} from session ${conn.sessionId}: ${error instanceof Error ? error.stack : error}`,
      );
      this.sendError(conn, id, ERR_OTHER, 'Internal error');
    }
  }

  // ---------------------------------------------------------------------
  // Protocol handlers
  // ---------------------------------------------------------------------

  private handleSubscribe(conn: WorkerConnection, id: unknown) {
    conn.subscribed = true;
    this.sendResult(conn, id, [conn.sessionId, conn.nonce1.toString('hex')]);
  }

  private handleAuthorize(
    conn: WorkerConnection,
    id: unknown,
    params: unknown[],
  ) {
    const rawWorkerName = typeof params[0] === 'string' ? params[0] : 'worker';
    const { name, presetKey } = this.parseWorkerName(rawWorkerName);
    const preset = resolvePreset(presetKey);

    conn.workerName = name;
    conn.presetKey = preset.key;
    conn.shareDifficulty = shareDifficultyForPreset(preset);

    this.sendResult(conn, id, true);
    this.logger.log(
      `Worker authorized: ${name} (session ${conn.sessionId}, preset ${preset.key})`,
    );

    if (this.currentJob) {
      this.sendTargetForConnection(conn);
      this.sendJob(conn, this.currentJob, true);
    }
  }

  /** Selects a difficulty preset via a worker-name suffix, e.g. "myrig.z15pro". Falls back to the pool default. */
  private parseWorkerName(raw: string): { name: string; presetKey: string } {
    const match = raw.match(/\.(z9mini|z15pro|z15)$/i);
    if (match) {
      return {
        name: raw.slice(0, -match[0].length),
        presetKey: match[1].toLowerCase(),
      };
    }
    return { name: raw, presetKey: DEFAULT_PRESET_KEY };
  }

  private handleSubmit(conn: WorkerConnection, id: unknown, params: unknown[]) {
    if (!conn.subscribed)
      return this.sendError(conn, id, ERR_NOT_SUBSCRIBED, 'Not subscribed');
    if (!conn.workerName)
      return this.sendError(
        conn,
        id,
        ERR_UNAUTHORIZED_WORKER,
        'Unauthorized worker',
      );

    const [, jobId, timeHex, nonce2Hex, solutionHex] = params as (
      string | undefined
    )[];
    if (!jobId || !timeHex || !nonce2Hex || !solutionHex) {
      return this.sendError(conn, id, ERR_OTHER, 'Malformed submission');
    }

    const job = this.jobs.get(jobId);
    if (!job)
      return this.sendError(
        conn,
        id,
        ERR_JOB_NOT_FOUND,
        'Job not found (stale)',
      );

    let nonce2: Buffer;
    let solutionWithPrefix: Buffer;
    let timeBytes: Buffer;
    try {
      nonce2 = Buffer.from(nonce2Hex, 'hex');
      solutionWithPrefix = Buffer.from(solutionHex, 'hex');
      timeBytes = Buffer.from(timeHex, 'hex');
    } catch {
      return this.sendError(
        conn,
        id,
        ERR_OTHER,
        'Malformed submission encoding',
      );
    }

    const expectedNonce2Len = 32 - conn.nonce1.length;
    if (nonce2.length !== expectedNonce2Len || timeBytes.length !== 4) {
      return this.sendError(conn, id, ERR_OTHER, 'Malformed submission length');
    }

    const dedupeKey = `${nonce2Hex}:${timeHex}`;
    if (job.seen.has(dedupeKey))
      return this.sendError(conn, id, ERR_DUPLICATE_SHARE, 'Duplicate share');
    job.seen.add(dedupeKey);

    const nonceBytes = Buffer.concat([conn.nonce1, nonce2]);
    let headerWithoutSolution: Buffer;
    try {
      headerWithoutSolution = assembleHeaderWithoutSolution(
        job.fields,
        timeBytes,
        nonceBytes,
      );
    } catch (error) {
      return this.sendError(
        conn,
        id,
        ERR_OTHER,
        error instanceof Error ? error.message : 'Header assembly failed',
      );
    }
    const fullHeader = assembleFullHeader(
      headerWithoutSolution,
      solutionWithPrefix,
    );
    const hash = headerHashToBigInt(doubleSha256(fullHeader));

    if (hash > conn.currentTarget) {
      conn.rejectedShares++;
      return this.sendError(
        conn,
        id,
        ERR_LOW_DIFFICULTY_SHARE,
        'Low difficulty share',
      );
    }

    if (isEquihashVerifyAvailable()) {
      let solutionBody: Buffer;
      try {
        const { bytesRead } = readCompactSize(solutionWithPrefix, 0);
        solutionBody = solutionWithPrefix.subarray(bytesRead);
      } catch {
        conn.rejectedShares++;
        return this.sendError(
          conn,
          id,
          ERR_OTHER,
          'Malformed solution encoding',
        );
      }
      let valid: boolean;
      try {
        valid = verifyEquihashSolution(headerWithoutSolution, solutionBody);
      } catch (error) {
        this.logger.error(
          `equihashverify threw: ${error instanceof Error ? error.message : error}`,
        );
        conn.rejectedShares++;
        return this.sendError(conn, id, ERR_OTHER, 'Verification error');
      }
      if (!valid) {
        conn.rejectedShares++;
        this.logger.warn(
          `Rejected invalid Equihash solution from worker ${conn.workerName}`,
        );
        return this.sendError(conn, id, ERR_OTHER, 'Invalid Equihash solution');
      }
    } else {
      this.logger.warn(
        'equihashverify unavailable — accepting share on target-hash check only, not cryptographically verified',
      );
    }

    // Accepted share.
    conn.acceptedShares++;
    conn.lastShareAt = Date.now();
    const achievedDifficulty = difficultyFromHash(job.diff1Target, hash);
    conn.recentShareDifficulties.push({
      at: Date.now(),
      difficulty: achievedDifficulty,
    });
    this.pruneOldShares(conn);
    if (achievedDifficulty > conn.bestShareDifficulty) {
      conn.bestShareDifficulty = achievedDifficulty;
    }
    if (achievedDifficulty > this.bestShareDifficultyEver) {
      this.bestShareDifficultyEver = achievedDifficulty;
      this.bestShareDifficultyWorker = conn.workerName;
      this.bestShareDifficultyAt = new Date();
      this.logger.log(
        `🍀 New best share difficulty: ${achievedDifficulty.toExponential(3)} by ${conn.workerName}`,
      );
      void this.persistStats();
    }
    this.sendResult(conn, id, true);

    if (hash <= job.networkTarget) {
      this.logger.log(
        `🎉 Possible block found by ${conn.workerName} at height ${job.template.height}!`,
      );
      void this.submitFoundBlock(job, fullHeader);
    }
  }

  private pruneOldShares(conn: WorkerConnection) {
    const cutoff = Date.now() - SHARE_WINDOW_MS;
    conn.recentShareDifficulties = conn.recentShareDifficulties.filter(
      (s) => s.at >= cutoff,
    );
  }

  private async persistStats() {
    await savePoolStats({
      blocksFound: this.blocksFound,
      lastBlockFoundAt: this.lastBlockFoundAt?.toISOString(),
      lastBlockFoundHeight: this.lastBlockFoundHeight,
      bestShareDifficultyEver: this.bestShareDifficultyEver,
      bestShareDifficultyWorker: this.bestShareDifficultyWorker,
      bestShareDifficultyAt: this.bestShareDifficultyAt?.toISOString(),
    });
  }

  private async submitFoundBlock(job: Job, fullHeader: Buffer) {
    const coinbaseHex = job.template.coinbasetxn.data;
    const otherTxHex = job.template.transactions.map((t) => t.data);
    const blockHex = assembleBlockHex(fullHeader, coinbaseHex, otherTxHex);
    try {
      const rejectReason = await this.nodeService.submitBlock(blockHex);
      if (rejectReason) {
        this.logger.error(
          `submitblock rejected our block at height ${job.template.height}: ${rejectReason}`,
        );
      } else {
        this.blocksFound++;
        this.lastBlockFoundAt = new Date();
        this.lastBlockFoundHeight = job.template.height;
        this.logger.log(
          `✅ Block ${job.template.height} accepted by the node!`,
        );
        void this.persistStats();
      }
    } catch (error) {
      this.logger.error(
        `submitblock call failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Outbound messages
  // ---------------------------------------------------------------------

  private sendTargetForConnection(conn: WorkerConnection) {
    if (!this.currentJob) return;
    const desired = shareDifficultyToTarget(
      this.currentJob.diff1Target,
      conn.shareDifficulty,
    );
    conn.currentTarget = clampShareTarget(
      desired,
      this.currentJob.networkTarget,
    );
    this.notify(conn, 'mining.set_target', [
      bigIntToTargetHex(conn.currentTarget),
    ]);
  }

  private sendJob(conn: WorkerConnection, job: Job, cleanJobs: boolean) {
    this.notify(conn, 'mining.notify', [
      job.id,
      job.fields.versionBytes.toString('hex'),
      job.fields.prevHashBytes.toString('hex'),
      job.fields.merkleRootBytes.toString('hex'),
      job.fields.reservedBytes.toString('hex'),
      job.fields.suggestedTimeBytes.toString('hex'),
      job.fields.bitsBytes.toString('hex'),
      cleanJobs,
    ]);
  }

  private send(conn: WorkerConnection, payload: unknown) {
    if (conn.socket.destroyed) return;
    conn.socket.write(JSON.stringify(payload) + '\n');
  }

  private sendResult(conn: WorkerConnection, id: unknown, result: unknown) {
    this.send(conn, { id, result, error: null });
  }

  private sendError(
    conn: WorkerConnection,
    id: unknown,
    code: number,
    message: string,
  ) {
    this.send(conn, { id, result: null, error: [code, message, null] });
  }

  private notify(conn: WorkerConnection, method: string, params: unknown[]) {
    this.send(conn, { id: null, method, params });
  }
}
