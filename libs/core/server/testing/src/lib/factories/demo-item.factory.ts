import { faker } from '@faker-js/faker';
import { Factory } from 'fishery';

/** Shape of the create request, not of the row: factories build inputs. */
export interface DemoItemInput {
  title: string;
}

/**
 * Deterministic by default: the seed is fixed so a failing test reproduces
 * with the same data. Call `faker.seed()` in a test that needs fresh values.
 */
faker.seed(20260902);

export const demoItemFactory = Factory.define<DemoItemInput>(
  ({ sequence }) => ({
    title: `${faker.commerce.productName()} #${sequence}`,
  }),
);
