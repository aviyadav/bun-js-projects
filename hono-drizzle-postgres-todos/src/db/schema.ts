import { 
    boolean,
    pgTable, 
    integer, 
    varchar, 
    timestamp, 
    uuid, 
    check 
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm/sql";

export const usersTable = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: varchar({ length: 256 }).notNull().unique(),
  passwordHash: varchar({ length: 500 }).notNull(),
  age: integer(),
  createdAt: timestamp({ withTimezone: true }).defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow(),
}, 
(table) => [
    check('age_check1', sql`${table.age} >= 0`),
    check('age_check2', sql`${table.age} <= 120`),
]
);

export const todosTable = pgTable('todos', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid()
    .notNull()
    .references(() => usersTable.id, { onDelete: 'cascade' }),
  title: varchar({ length: 500 }).notNull(),
  description: varchar({ length: 1000 }),
  completed: boolean().default(false),
  createdAt: timestamp({ withTimezone: true }).defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).defaultNow(),
});