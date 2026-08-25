import { Module } from '@nestjs/common';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';
import { NodeModule } from './node/node.module';
import { PoolModule } from './pool/pool.module';

@Module({
  imports: [
    NodeModule,
    PoolModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
    }),
  ],
})
export class AppModule {}
