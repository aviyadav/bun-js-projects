import type { UUID } from 'crypto';
import { db } from './db';
import { todosTable, usersTable } from './schema';
import { desc, eq } from 'drizzle-orm';

export type NewTodo = {
  userId: UUID;
  title: string;
  description?: string;
  completed?: boolean;
};

export const insertUser = async (email: string, password: string) => {
  const passwordHash = await Bun.password.hash(password);

  const [user] = await db
    .insert(usersTable)
    .values({
      email,
      passwordHash,
    })
    .returning();

  return user.id as UUID;
};

export const insertTodo = async (todo: NewTodo) => {
  const [createdTodo] = await db.insert(todosTable).values(todo).returning();

  return createdTodo;
};

export const getTodosByUserId = async (userId: UUID) => {
  const todos = await db
    .select()
    .from(todosTable)
    .where(eq(todosTable.userId, userId))
    .orderBy(desc(todosTable.createdAt));

  return todos;
};