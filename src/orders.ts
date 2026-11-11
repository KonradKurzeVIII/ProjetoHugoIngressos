import type { Pool } from "pg";
import { transaction } from "./database.js";
import { ApiError } from "./errors.js";
import { FifoQueue } from "./fifo.js";

export type OrderStatus = "NO_CARRINHO" | "RESERVADO" | "CANCELADO";
export interface Order { id: number; status: OrderStatus }
export interface Availability { total: number; ocupadas: number; livres: number }

export class Orders {
  private readonly fifo = new FifoQueue();

  constructor(private readonly pool: Pool) {}

  async list(userId: number): Promise<Order[]> {
    const result = await this.pool.query<Order>(
      "SELECT id, status FROM orders WHERE user_id = $1 ORDER BY id DESC",
      [userId],
    );
    return result.rows;
  }

  async create(userId: number): Promise<Order> {
    const result = await this.pool.query<Order>(
      "INSERT INTO orders (user_id, show_id) VALUES ($1, 7) RETURNING id, status",
      [userId],
    );
    return result.rows[0]!;
  }

  mutate(userId: number, id: number, action: "reservar" | "cancelar"): Promise<Order> {
    // No connection or transaction is held while waiting for admission order.
    return this.fifo.run(`${action}:${id}`, () => transaction(this.pool, async (client) => {
      // Every reservation and cancellation acquires this lock first.
      // Serialize mutations without blocking the foreign-key check for new carts.
      await client.query("SELECT id FROM shows WHERE id = 7 FOR NO KEY UPDATE");
      const found = await client.query<Order>(
        "SELECT id, status FROM orders WHERE id = $1 AND user_id = $2",
        [id, userId],
      );
      const order = found.rows[0];
      if (!order) throw new ApiError(404, "NAO_ENCONTRADO");

      const target = action === "reservar" ? "RESERVADO" : "CANCELADO";
      if (order.status === target) return order; // Idempotent retry.
      const source = action === "reservar" ? "NO_CARRINHO" : "RESERVADO";
      if (order.status !== source) throw new ApiError(409, "ESTADO_INVALIDO");

      if (action === "reservar") {
        const counts = await client.query<{ occupied: number; personal: number }>(
          `SELECT count(*)::int AS occupied,
             (count(*) FILTER (WHERE user_id = $1))::int AS personal
           FROM orders WHERE show_id = 7 AND status = 'RESERVADO'`,
          [userId],
        );
        const { occupied, personal } = counts.rows[0]!;
        if (personal >= 2) throw new ApiError(409, "COTA_PESSOAL");
        if (occupied >= 100) throw new ApiError(409, "POOL_CHEIO");
      }

      const changed = await client.query<Order>(
        `UPDATE orders SET status = $1, updated_at = now()
         WHERE id = $2 AND user_id = $3 AND status = $4 RETURNING id, status`,
        [target, id, userId, source],
      );
      if (!changed.rows[0]) throw new Error("Order changed outside the show lock");
      return changed.rows[0];
    }));
  }

  async availability(): Promise<Availability> {
    // One MVCC snapshot: the three fields can never disagree with one another.
    const result = await this.pool.query<Availability>(
      `SELECT 100::int AS total, count(*)::int AS ocupadas,
         (100 - count(*))::int AS livres
       FROM orders WHERE show_id = 7 AND status = 'RESERVADO'`,
    );
    return result.rows[0]!;
  }

  async drain(): Promise<void> { await this.fifo.drain(); }
}
