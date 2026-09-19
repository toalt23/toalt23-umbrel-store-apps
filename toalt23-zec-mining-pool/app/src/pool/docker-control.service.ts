import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';

/** Restarts the zakura container over the mounted Docker socket after a mining-address change.
 * Hand-rolled to one narrow call on purpose — a docker-socket-proxy would allowlist this
 * properly, but isn't worth the extra container at this scale (see PROGRESS.md). */
@Injectable()
export class DockerControlService {
  private readonly logger = new Logger(DockerControlService.name);
  private readonly socketPath =
    process.env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';
  private readonly zakuraContainerName =
    process.env.ZAKURA_CONTAINER_NAME ?? 'toalt23-zec-mining-pool_zakura_1';

  /** Returns true on success; false (never throws) on any failure — callers should tell the user to restart manually rather than fail the save. */
  async restartZakuraContainer(): Promise<boolean> {
    try {
      await this.dockerApiRequest(
        'POST',
        `/containers/${encodeURIComponent(this.zakuraContainerName)}/restart`,
      );
      this.logger.log(
        `Restarted ${this.zakuraContainerName} to apply the new mining address.`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not restart ${this.zakuraContainerName} automatically (${error instanceof Error ? error.message : error}). ` +
          'The mining address is saved, but you may need to restart it manually for the change to take effect.',
      );
      return false;
    }
  }

  private dockerApiRequest(method: string, path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            if (
              res.statusCode &&
              res.statusCode >= 200 &&
              res.statusCode < 300
            ) {
              resolve();
              return;
            }
            const body = Buffer.concat(chunks).toString('utf8');
            reject(new Error(`Docker API returned ${res.statusCode}: ${body}`));
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () =>
        req.destroy(new Error('Docker API request timed out')),
      );
      req.end();
    });
  }
}
