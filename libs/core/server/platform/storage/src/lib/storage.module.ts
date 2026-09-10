import { Logger, Module } from '@nestjs/common';

import { BaseConfig } from '@workspace/core-server-core';

import { LocalDriver } from './local.driver.js';
import { S3Driver } from './s3.driver.js';
import { STORAGE_DRIVER, type StorageDriver } from './storage.driver.js';

/**
 * Whichever driver the deployment chose.
 *
 * A factory rather than two modules, because the choice is a value and the
 * rest of the system must not be able to tell which one it got — that is the
 * whole point of the interface, and it is what lets the same suite run against
 * both.
 *
 * The settings are read here and validated by the schema, so a `s3` driver
 * with no bucket fails at boot with the variable's name rather than on the
 * first upload.
 */
@Module({
  providers: [
    {
      provide: STORAGE_DRIVER,
      inject: [BaseConfig],
      useFactory: (config: BaseConfig): StorageDriver => {
        const driver = config.get('STORAGE_DRIVER');
        const logger = new Logger('StorageModule');

        if (driver === 'local') {
          const secret = config.get('STORAGE_SIGNING_SECRET');

          if (secret === undefined) {
            // Refused at boot rather than on the first upload. A local driver
            // with no key would hand out URLs anybody could forge, and the
            // failure would look like the feature working.
            throw new Error(
              'STORAGE_DRIVER is "local", which signs its own URLs, so ' +
                'STORAGE_SIGNING_SECRET is required. Any 32-character secret will do; ' +
                'it never leaves this deployment.',
            );
          }

          const local = new LocalDriver({
            root: config.get('STORAGE_LOCAL_ROOT'),
            publicOrigin: config.get('STORAGE_PUBLIC_ORIGIN'),
            secret,
            signedUrlTtlSeconds: config.get('STORAGE_SIGNED_URL_TTL_SECONDS'),
          });

          logger.log(
            `Storing files on disk at ${config.get('STORAGE_LOCAL_ROOT')}. ` +
              'Signed URLs are real — the receiving route verifies them.',
          );

          return local;
        }

        const s3 = new S3Driver({
          endpoint: config.get('S3_ENDPOINT'),
          region: config.get('S3_REGION'),
          bucket: config.get('S3_BUCKET'),
          accessKey: config.get('S3_ACCESS_KEY'),
          secretKey: config.get('S3_SECRET_KEY'),
          signedUrlTtlSeconds: config.get('STORAGE_SIGNED_URL_TTL_SECONDS'),
        });

        logger.log(
          `Storing files in ${config.get('S3_BUCKET')} at ${config.get('S3_ENDPOINT')}.`,
        );

        return s3;
      },
    },
  ],
  exports: [STORAGE_DRIVER],
})
export class StorageModule {}
