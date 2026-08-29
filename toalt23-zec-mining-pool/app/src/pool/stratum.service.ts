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
  presetByKey,
  resolvePreset,
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
const LONGPOLL_MIN_BACKOFF_MS = 1000;
const LONGPOLL_MAX_BACKOFF_MS = 30000;
// How long the long-poll loop waits before retrying when it has no
// longpollid yet (node never reachable, or doesn't support it at all) —
// deliberately short so a template becoming available is picked up quickly,
// but not a busy-loop.
const LONGPOLL_RETRY_WITHOUT_ID_MS = 5000;

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
  // Long-poll (below) is the primary way a *new block* gets pushed out, but
  // this plain poll still has its own job: catching mempool-only changes
  // (new fee-paying transactions arriving) between blocks. Zakura's
  // longpollid is only confirmed to unblock on a new tip (see PROGRESS.md's
  // open validation item) — it's unverified whether it also treats a
  // mempool-only change as "stale", so this is the one thing we know
  // deliberately refreshes the coinbase/template mid-block, not just a
  // rarely-used fallback. Kept fairly short (not widened all the way back
  // to a "safety net only" cadence) so miners aren't left grinding on a
  // template that's minutes stale.
  private readonly pollIntervalMs = Number(
    process.env.POOL_POLL_INTERVAL_MS ?? 30000,
  );
  private readonly longPollTimeoutMs = Number(
    process.env.POOL_LONGPOLL_TIMEOUT_MS ?? 90000,
  );

  private server?: net.Server;
  private pollTimer?: NodeJS.Timeout;
  private longPollSleepTimer?: NodeJS.Timeout;
  private readonly connections = new Map<string, WorkerConnection>();
  private readonly jobs = new Map<string, Job>();
  private currentJob: Job | null = null;
  private jobCounter = 0;
  private nonce1Counter = 0;
  private lastKnownDifficulty?: number;
  // Guards applyTemplate() itself (not the RPC fetch) — the plain fallback
  // poll and the long-poll loop can both resolve a template at roughly the
  // same time, and only one should be allowed to build/broadcast a job at
  // once.
  private applying = false;
  // Guards pollTemplate() specifically, so the fallback timer never has two
  // of its own fetches in flight at once.
  private pollingFallback = false;
  private lastLongpollId?: string;
  private longPollBackoffMs = 0;
  private stopped = false;

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
    void this.runLongPollLoop();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.longPollSleepTimer) clearTimeout(this.longPollSleepTimer);
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

  /**
   * Plain, non-blocking fetch — used for the initial template on startup
   * and as the slow fallback timer's tick. The long-poll loop below is the
   * primary path once it has a longpollid to work with; this just
   * guarantees we're never more than pollIntervalMs behind even if that
   * connection stalls silently.
   */
  private async pollTemplate() {
    if (this.pollingFallback) return; // don't overlap if a previous call is slow
    this.pollingFallback = true;
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
      await this.applyTemplate(template, 'poll');
    } finally {
      this.pollingFallback = false;
    }
  }

  /**
   * Recursive BIP-22 long-poll loop — the closest thing to ZMQ-style block
   * push this node can offer. Zebra/Zakura has no ZMQ (a zcashd-only
   * feature), so this is the ceiling of what's achievable here; see
   * PROGRESS.md for the research behind that conclusion. Each round blocks
   * server-side in getblocktemplate on the last-seen longpollid until the
   * node considers it stale (normally: a new block), applies whatever comes
   * back, then immediately re-issues with the fresh id. Runs for the
   * lifetime of the service — stopped only via `this.stopped` in
   * onModuleDestroy.
   */
  private async runLongPollLoop() {
    while (!this.stopped) {
      const longpollId = this.lastLongpollId;
      if (!longpollId) {
        // Nothing to long-poll on yet — the initial plain fetch hasn't
        // succeeded yet, or this node/version doesn't return a longpollid
        // at all. Wait for the fallback timer to (maybe) produce one
        // rather than busy-looping.
        await this.sleep(LONGPOLL_RETRY_WITHOUT_ID_MS);
        continue;
      }

      try {
        const template = await this.nodeService.getBlockTemplateLongPoll(
          longpollId,
          this.longPollTimeoutMs,
        );
        if (this.stopped) return;
        await this.applyTemplate(template, 'longpoll');
        this.longPollBackoffMs = 0; // reset after a clean round-trip
      } catch (error) {
        if (this.stopped) return;
        this.lastTemplateError =
          error instanceof Error ? error.message : String(error);
        this.longPollBackoffMs = this.longPollBackoffMs
          ? Math.min(this.longPollBackoffMs * 2, LONGPOLL_MAX_BACKOFF_MS)
          : LONGPOLL_MIN_BACKOFF_MS;
        // Debug, not warn: this fires routinely on the expected
        // ECONNREFUSED burst when zakura auto-restarts after a
        // mining-address change (see PROGRESS.md gotcha #3), not just on
        // genuine faults.
        this.logger.debug(
          `Long-poll getblocktemplate failed, backing off ${this.longPollBackoffMs}ms: ` +
            this.lastTemplateError,
        );
        await this.sleep(this.longPollBackoffMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.longPollSleepTimer = setTimeout(resolve, ms);
    });
  }

  /**
   * Turns a fetched template (from either the plain poll or the long-poll
   * loop) into a job and broadcasts it if anything actually changed.
   * Guarded against overlapping with itself: the plain fallback poll and
   * the long-poll loop can each resolve a template at roughly the same
   * time, and only one should build/broadcast a job at once.
   *
   * `source` is only used for logging — it's what lets us tell from the
   * logs alone whether long-poll is actually earning its keep (jobs
   * arriving via 'longpoll' right as a block lands) versus everything
   * still coming from the 'poll' fallback, and whether a mempool-only
   * refresh (see PROGRESS.md's open validation item) is coming from
   * long-poll or only ever from the plain poll.
   */
  private async applyTemplate(
    template: BlockTemplateResult,
    source: 'longpoll' | 'poll',
  ) {
    if (this.applying) return;
    this.applying = true;
    try {
      this.lastLongpollId = template.longpollid;
      this.lastTemplateError = undefined;
      this.lastTemplateFetchedAt = new Date();

      const prevJob = this.currentJob;
      const changed =
        !prevJob ||
        prevJob.template.previousblockhash !== template.previousblockhash ||
        prevJob.template.defaultroots?.merkleroot !==
          template.defaultroots?.merkleroot;
      if (!changed) {
        // Only notable for 'longpoll': it resolved but nothing actually
        // changed, which — if it happens right away rather than after a
        // long block-sized wait — is a sign the node isn't really blocking
        // on longpollid (see PROGRESS.md's open validation item). Expected
        // and unremarkable for 'poll', which always fetches a live
        // snapshot regardless of whether it changed.
        if (source === 'longpoll') {
          this.logger.debug(
            'Long-poll resolved with no actual template change (unexpected unless it was a long wait).',
          );
        }
        return;
      }

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

      const reason = cleanJobs ? 'new block' : 'mempool refresh, same block';
      this.logger.log(
        `New job ${jobId} via ${source} (${reason}) — height ${template.height}, ` +
          `${this.connections.size} connection(s), clean_jobs=${cleanJobs}`,
      );

      for (const conn of this.connections.values()) {
        if (!conn.subscribed || !conn.workerName) continue;
        this.sendTargetForConnection(conn);
        this.sendJob(conn, job, cleanJobs);
      }
    } finally {
      this.applying = false;
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
      shareDifficulty: defaultPreset.shareDifficulty,
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
    const name = typeof params[0] === 'string' ? params[0] : 'worker';
    const rawPassword = typeof params[1] === 'string' ? params[1] : '';
    const presetKey = this.parsePasswordPreset(rawPassword);
    const preset = resolvePreset(presetKey);

    conn.workerName = name;
    conn.presetKey = preset.key;
    conn.shareDifficulty = preset.shareDifficulty;

    this.sendResult(conn, id, true);
    this.logger.log(
      `Worker authorized: ${name} (session ${conn.sessionId}, preset ${preset.key})`,
    );

    if (this.currentJob) {
      this.sendTargetForConnection(conn);
      this.sendJob(conn, this.currentJob, true);
    }
  }

  /**
   * Selects a difficulty preset via the stratum password field
   * (`mining.authorize("<worker>", "<password>")`), e.g. password "high" →
   * difficulty 256. The worker name itself is left untouched — no more
   * ".<preset>" suffix parsing, so it's shown back exactly as the miner
   * configured it. "mid" is accepted as an alias for "medium". Anything
   * else (blank, typo, unset) falls back to the pool default preset.
   */
  private parsePasswordPreset(rawPassword: string): string {
    const normalized = rawPassword.trim().toLowerCase();
    if (normalized === 'mid') return 'medium';
    return presetByKey(normalized) ? normalized : DEFAULT_PRESET_KEY;
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
