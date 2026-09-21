import * as schema from '../src/db/schema';
import { reset, seed } from 'drizzle-seed';
import { db, pool } from '../src/db/db';

export const seedDb = async () => {
  await reset(db, schema);

  await seed(db, schema).refine((funcs) => ({
    usersTable: {
      columns: {
        age: funcs.int({ minValue: 0, maxValue: 120 }),
      },
      count: 10,
      with: {
        todosTable: 10,
      },
    },
    todosTable: {
      columns: {
        title: funcs.valuesFromArray({
          values: [
            'Buy groceries',
            'walk the dog',
            'read a book',
            'write some code',
            'go for a run',
          ],
        }),
        description: funcs.valuesFromArray({
          values: [
            'very carefully',
            'very focused',
            'remember to stretch',
            'keep things clean',
          ],
        }),
      },
    },
  }));
};

seedDb()
  .then(() => {
    console.log('Database seed successfully');
    return pool.end();
  })
  .catch((err) => {
    console.log(err);
    return pool.end();
  });