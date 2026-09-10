import {
  createDemoItemSchema,
  demoItemPageSchema,
  demoItemSchema,
  listDemoItemsQuerySchema,
} from '@workspace/shared-contracts';
import { createZodDto } from 'nestjs-zod';

export class CreateDemoItemDto extends createZodDto(createDemoItemSchema) {}
export class ListDemoItemsQueryDto extends createZodDto(
  listDemoItemsQuerySchema,
) {}
export class DemoItemDto extends createZodDto(demoItemSchema) {}
export class DemoItemPageDto extends createZodDto(demoItemPageSchema) {}
