import { Injectable, Logger } from '@nestjs/common';
import * as http from 'http';

/**
 * Talks to the Docker Engine API over the mounted socket (/var/run/docker.sock)
 * to restart the zakura container after a mining-address change, so the new
 * address takes effect without restarting the whole app.
 *
 * Deliberately hand-rolled instead of pulling in a general Docker client
 * library: this is the ONE narrow call this service is allowed to make, and
 * keeping it that way limits how much a bug here could do. That said, once
 * the socket is mounted, anything else running in this container also has
 * full, unrestricted Docker API access — no amount of care in this file
 * changes that. A docker-socket-proxy (e.g. tecnativa/docker-socket-proxy)
 * sitting between the app and dockerd, allowlisting only this one endpoint,
 * would close that gap properly; not done here to keep this deployable
 * without an extra container.
 */
@Injectable()
export class DockerControlService {
  private readonly logger = new Logger(DockerControlService.name);
  private readonly socketPath =
    process.env.DOCKER_SOCKET_PATH ?? '/var/run/docker.sock';
  private readonly zakuraContainerName =
    process.env.ZAKURA_CONTAINER_NAME ?? 'toalt23-zec-mining-pool_zakura_1';

  /**
   * Restarts the zakura container so it picks up a freshly written
   * ZAKURA_MINING__MINER_ADDRESS. Returns true on success; false (never
   * throws) if the socket isn't mounted, the container can't be found, or
   * anything else goes wrong — callers should fall back to telling the user
   * to restart manually rather than fail the address save itself.
   */
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
