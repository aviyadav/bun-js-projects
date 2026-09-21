import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { insertTodo, getTodosByUserId, NewTodo, insertUser } from './queries';
import {
  createTestDb,
  destroyTestDb,
  TestDbContext,
} from '../test/setup-test-db';

let ctx: TestDbContext;

beforeEach(async () => {
  ctx = await createTestDb();
});

afterEach(async () => {
  if (ctx) {
    await destroyTestDb(ctx);
  }
});

describe('insertTodo', () => {
  it('should insert a todo into the database', async () => {
    const userId = await insertUser('test@test.com', 'password123');

    const newTodo = {
      userId: userId,
      title: 'Test todo',
      description: 'this is a test todo',
    } as NewTodo;
    const todo = await insertTodo(newTodo);

    expect(todo.id).toBeDefined();
    expect(todo.userId).toBe(newTodo.userId);
  });
});

describe('getTodosByUserId', () => {
  it('should return todos for a given user id', async () => {
    const userId = await insertUser('test@test.com', 'password123');

    const newTodo1 = {
      userId: userId,
      title: 'Test todo 1',
      description: 'this is a test todo',
    } as NewTodo;

    const newTodo2 = {
      userId: userId,
      title: 'Test todo 2',
      description: 'this is a test todo',
    } as NewTodo;

    await insertTodo(newTodo1);
    await insertTodo(newTodo2);

    const todos = await getTodosByUserId(userId);
    expect(todos.length).toBe(2);
  });
});