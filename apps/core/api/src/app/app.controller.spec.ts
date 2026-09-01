import { Test, TestingModule } from '@nestjs/testing';
import { describe, beforeAll, it, expect } from 'vitest';

import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();
  });

  it('returns the greeting payload from AppService', () => {
    const controller = app.get<AppController>(AppController);

    expect(controller.getData()).toEqual({ message: 'Hello API' });
  });
});
